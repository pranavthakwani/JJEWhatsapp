import { input, query, sql } from './sqlHelpers.js';

export async function resolvePendingOfferingPrices({ messageId, conversationId, parentProviderMessageId, prices, lookbackMinutes = 120 }) {
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @pending TABLE(sequence_no int IDENTITY(0,1), offering_id bigint);
    DECLARE @priceCount int = (SELECT COUNT(*) FROM OPENJSON(@pricesJson));

    INSERT @pending(offering_id)
    SELECT offering.offering_id
    FROM jje.offerings offering WITH (UPDLOCK,HOLDLOCK)
    INNER JOIN jje.message_analysis analysis ON analysis.message_analysis_id=offering.message_analysis_id
    INNER JOIN jje.messages origin ON origin.message_id=analysis.message_id
    LEFT JOIN jje.messages price_request ON price_request.message_id=offering.price_request_message_id
    INNER JOIN jje.messages reply ON reply.message_id=@messageId
    WHERE offering.status='pending_price' AND origin.conversation_id=@conversationId
      AND origin.created_at BETWEEN DATEADD(minute,-@lookbackMinutes,reply.created_at) AND reply.created_at
      AND (@parentProviderId IS NULL OR origin.provider_message_id=@parentProviderId OR price_request.provider_message_id=@parentProviderId)
    ORDER BY origin.created_at DESC,offering.item_index;

    IF @parentProviderId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM @pending)
      INSERT @pending(offering_id)
      SELECT offering.offering_id
      FROM jje.offerings offering WITH (UPDLOCK,HOLDLOCK)
      INNER JOIN jje.message_analysis analysis ON analysis.message_analysis_id=offering.message_analysis_id
      INNER JOIN jje.messages origin ON origin.message_id=analysis.message_id
      INNER JOIN jje.messages reply ON reply.message_id=@messageId
      WHERE offering.status='pending_price' AND origin.conversation_id=@conversationId
        AND origin.created_at BETWEEN DATEADD(minute,-@lookbackMinutes,reply.created_at) AND reply.created_at
      ORDER BY origin.created_at DESC,offering.item_index;

    DECLARE @pendingCount int=(SELECT COUNT(*) FROM @pending),@updated int=0;
    IF @pendingCount>0 AND @pendingCount=@priceCount
    BEGIN
      UPDATE offering SET price_min=price.amount,price_max=price.amount,status='complete',
        price_source_message_id=@messageId,updated_at=SYSUTCDATETIME()
      FROM jje.offerings offering
      INNER JOIN @pending pending ON pending.offering_id=offering.offering_id
      INNER JOIN OPENJSON(@pricesJson) WITH(sequence_no int '$.sequence',amount decimal(19,4) '$.amount') price
        ON price.sequence_no=pending.sequence_no;
      SET @updated=@@ROWCOUNT;
    END
    ELSE IF @pendingCount>0
      UPDATE offering SET pending_followup_count=pending_followup_count+1,updated_at=SYSUTCDATETIME()
      FROM jje.offerings offering INNER JOIN @pending pending ON pending.offering_id=offering.offering_id;

    IF @updated>0
      INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json)
      VALUES('analysis.offering_price_resolved','message',@messageId,
        (SELECT @messageId messageId,@updated offeringCount FOR JSON PATH,WITHOUT_ARRAY_WRAPPER));
    COMMIT TRANSACTION;
    SELECT @pendingCount pending_count,@priceCount price_count,@updated updated_count;
  `, [
    input('messageId', sql.BigInt, messageId),
    input('conversationId', sql.BigInt, conversationId),
    input('parentProviderId', sql.VarChar(255), parentProviderMessageId || null),
    input('lookbackMinutes', sql.Int, lookbackMinutes),
    input('pricesJson', sql.NVarChar(sql.MAX), JSON.stringify(prices.map((amount, sequence) => ({ sequence, amount })))),
  ]);
  const row = result.recordset[0];
  return { pendingCount: Number(row.pending_count), priceCount: Number(row.price_count), updatedCount: Number(row.updated_count) };
}

export async function saveMessageAnalysis({ messageId, extraction, model, promptVersion, usage = {} }) {
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @analysisId bigint;
    SELECT @analysisId = message_analysis_id FROM jje.message_analysis WITH (UPDLOCK, HOLDLOCK)
      WHERE message_id = @messageId AND analysis_version = 1;
    IF @analysisId IS NULL
    BEGIN
      INSERT jje.message_analysis(message_id, analysis_version, classification, confidence, model_name,
        prompt_version, extracted_json, status, token_input, token_output)
      VALUES(@messageId, 1, @classification, @confidence, @model, @promptVersion,
        @extractedJson, 'completed', @tokenInput, @tokenOutput);
      SET @analysisId = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
      DELETE FROM jje.leads WHERE message_analysis_id = @analysisId;
      DELETE FROM jje.offerings WHERE message_analysis_id = @analysisId;
      UPDATE jje.message_analysis SET classification = @classification, confidence = @confidence,
        model_name = @model, prompt_version = @promptVersion, extracted_json = @extractedJson,
        status = 'completed', error_message = NULL, token_input = @tokenInput,
        token_output = @tokenOutput, updated_at = SYSUTCDATETIME()
      WHERE message_analysis_id = @analysisId;
    END;

    IF @classification = 'lead'
      INSERT jje.leads(message_analysis_id, item_index, brand, model, variant, ram_gb, storage_gb,
        colors_json, quantity_min, quantity_max, target_price_min, target_price_max,
        condition, gst_included, dispatch_location)
      SELECT @analysisId, CONVERT(smallint, source.item_index), source.brand, source.model, source.variant,
        source.ram_gb, source.storage_gb, source.colors_json, source.quantity_min, source.quantity_max,
        source.price_min, source.price_max, @condition, @gstIncluded,
        COALESCE(source.dispatch_location, @dispatch)
      FROM OPENJSON(@itemsJson) WITH (
        item_index int '$.itemIndex', brand nvarchar(100) '$.brand', model nvarchar(160) '$.model',
        variant nvarchar(160) '$.variant', ram_gb int '$.ramGb', storage_gb int '$.storageGb',
        colors_json nvarchar(max) '$.colors' AS JSON, quantity_min int '$.quantityMin',
        quantity_max int '$.quantityMax', price_min decimal(19,4) '$.priceMin',
        price_max decimal(19,4) '$.priceMax', dispatch_location nvarchar(240) '$.dispatchLocation'
      ) source;

    IF @classification = 'offering'
      INSERT jje.offerings(message_analysis_id, item_index, brand, model, variant, ram_gb, storage_gb,
        colors_json, quantity_min, quantity_max, price_min, price_max,
        condition, gst_included, dispatch_location, status)
      SELECT @analysisId, CONVERT(smallint, source.item_index), source.brand, source.model, source.variant,
        source.ram_gb, source.storage_gb, source.colors_json, source.quantity_min, source.quantity_max,
        source.price_min, source.price_max, @condition, @gstIncluded,
        COALESCE(source.dispatch_location, @dispatch),
        CASE WHEN source.price_min IS NULL AND source.price_max IS NULL THEN 'pending_price' ELSE 'complete' END
      FROM OPENJSON(@itemsJson) WITH (
        item_index int '$.itemIndex', brand nvarchar(100) '$.brand', model nvarchar(160) '$.model',
        variant nvarchar(160) '$.variant', ram_gb int '$.ramGb', storage_gb int '$.storageGb',
        colors_json nvarchar(max) '$.colors' AS JSON, quantity_min int '$.quantityMin',
        quantity_max int '$.quantityMax', price_min decimal(19,4) '$.priceMin',
        price_max decimal(19,4) '$.priceMax', dispatch_location nvarchar(240) '$.dispatchLocation'
      ) source;

    DECLARE @eventPayload nvarchar(max) = (SELECT @analysisId analysisId, @messageId messageId,
      @classification classification FOR JSON PATH, WITHOUT_ARRAY_WRAPPER);
    INSERT jje.outbox_events(event_type, aggregate_type, aggregate_id, payload_json)
      VALUES('analysis.completed', 'analysis', @analysisId, @eventPayload);
    COMMIT TRANSACTION;
    SELECT @analysisId AS analysis_id;`, [
    input('messageId', sql.BigInt, messageId),
    input('classification', sql.VarChar(30), extraction.classification),
    input('confidence', sql.Decimal(6, 5), extraction.confidence),
    input('model', sql.VarChar(100), model || null),
    input('promptVersion', sql.VarChar(50), promptVersion || null),
    input('extractedJson', sql.NVarChar(sql.MAX), JSON.stringify(extraction)),
    input('itemsJson', sql.NVarChar(sql.MAX), JSON.stringify(extraction.items.map((item, itemIndex) => ({ ...item, itemIndex })))),
    input('condition', sql.VarChar(30), extraction.condition || null),
    input('gstIncluded', sql.Bit, extraction.gstIncluded),
    input('dispatch', sql.NVarChar(240), extraction.dispatch || null),
    input('tokenInput', sql.Int, usage.inputTokens || null),
    input('tokenOutput', sql.Int, usage.outputTokens || null),
  ]);
  return Number(result.recordset[0].analysis_id);
}
