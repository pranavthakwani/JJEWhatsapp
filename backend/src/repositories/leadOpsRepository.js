import { clampInteger, input, iso, parseJson, query, sql } from './sqlHelpers.js';
import { actorUserId,actorKey } from '../agent/access.js';

const ITEM_TYPES = new Set(['leads', 'offerings', 'ignored']);
const LEAD_STATUSES = new Set(['open', 'matched', 'closed', 'archived']);
const OFFERING_STATUSES = new Set(['complete', 'pending_price', 'sold', 'archived']);

function dateWindow(days) {
  return clampInteger(days, 30, 1, 3650);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function itemPage(row, type) {
  return {
    id: Number(row.item_id),
    type,
    analysisId: Number(row.message_analysis_id),
    messageId: Number(row.message_id),
    conversationId: Number(row.conversation_id),
    contactId: Number(row.contact_id),
    contactName: row.contact_name || row.phone_number || row.wa_id,
    phoneNumber: row.phone_number || row.wa_id,
    sourceText: row.source_text,
    classification: row.classification,
    confidence: row.confidence === null ? null : Number(row.confidence),
    brand: row.brand,
    model: row.model,
    variant: row.variant,
    ramGb: row.ram_gb,
    storageGb: row.storage_gb,
    colors: parseJson(row.colors_json, []),
    quantityMin: row.quantity_min,
    quantityMax: row.quantity_max,
    priceMin: row.price_min === null ? null : Number(row.price_min),
    priceMax: row.price_max === null ? null : Number(row.price_max),
    condition: row.condition,
    gstIncluded: row.gst_included === null ? null : Boolean(row.gst_included),
    dispatchLocation: row.dispatch_location,
    status: row.item_status,
    createdAt: iso(row.created_at),
  };
}

function itemFilters({ days, brand, model, status, search, minPrice, maxPrice, minQuantity }) {
  return [
    input('days', sql.Int, dateWindow(days)),
    input('brand', sql.NVarChar(100), String(brand || '').trim() || null),
    input('model', sql.NVarChar(160), String(model || '').trim() || null),
    input('status', sql.VarChar(30), String(status || '').trim() || null),
    input('search', sql.NVarChar(240), String(search || '').trim() || null),
    input('minPrice', sql.Decimal(19, 4), optionalNumber(minPrice)),
    input('maxPrice', sql.Decimal(19, 4), optionalNumber(maxPrice)),
    input('minQuantity', sql.Int, optionalNumber(minQuantity)),
  ];
}

export async function getLeadOpsDashboard(days = 30) {
  const result = await query(`
    DECLARE @since datetime2(3)=DATEADD(day,-@days,SYSUTCDATETIME());
    SELECT
      (SELECT COUNT_BIG(*) FROM jje.leads WHERE created_at>=@since) leads,
      (SELECT COUNT_BIG(*) FROM jje.offerings WHERE created_at>=@since) offerings,
      (SELECT COUNT_BIG(*) FROM jje.message_analysis WHERE created_at>=@since AND classification IN ('ignored','unknown')) ignored,
      (SELECT COUNT_BIG(*) FROM jje.leads WHERE created_at>=@since AND status='open') open_leads,
      (SELECT COUNT_BIG(*) FROM jje.offerings WHERE created_at>=@since AND status='pending_price') pending_prices,
      (SELECT COUNT_BIG(DISTINCT message.contact_id) FROM jje.message_analysis analysis INNER JOIN jje.messages message ON message.message_id=analysis.message_id WHERE analysis.created_at>=@since) analyzed_contacts,
      (SELECT COALESCE(SUM(token_input),0) FROM jje.message_analysis WHERE created_at>=@since) token_input,
      (SELECT COALESCE(SUM(token_output),0) FROM jje.message_analysis WHERE created_at>=@since) token_output,
      (SELECT COUNT_BIG(*) FROM jje.background_jobs WHERE job_type='analyze_message' AND status='queued') queued_jobs,
      (SELECT COUNT_BIG(*) FROM jje.background_jobs WHERE job_type='analyze_message' AND status='failed') failed_jobs;

    ;WITH dates AS (
      SELECT CAST(@since AS date) activity_date
      UNION ALL SELECT DATEADD(day,1,activity_date) FROM dates WHERE activity_date<CAST(SYSUTCDATETIME() AS date)
    ), activity AS (
      SELECT CAST(created_at AS date) activity_date,'leads' kind,COUNT_BIG(*) total FROM jje.leads WHERE created_at>=@since GROUP BY CAST(created_at AS date)
      UNION ALL SELECT CAST(created_at AS date),'offerings',COUNT_BIG(*) FROM jje.offerings WHERE created_at>=@since GROUP BY CAST(created_at AS date)
      UNION ALL SELECT CAST(created_at AS date),'ignored',COUNT_BIG(*) FROM jje.message_analysis WHERE created_at>=@since AND classification IN ('ignored','unknown') GROUP BY CAST(created_at AS date)
    )
    SELECT dates.activity_date,
      COALESCE(MAX(CASE WHEN kind='leads' THEN total END),0) leads,
      COALESCE(MAX(CASE WHEN kind='offerings' THEN total END),0) offerings,
      COALESCE(MAX(CASE WHEN kind='ignored' THEN total END),0) ignored
    FROM dates LEFT JOIN activity ON activity.activity_date=dates.activity_date
    GROUP BY dates.activity_date ORDER BY dates.activity_date OPTION(MAXRECURSION 3660);`, [input('days', sql.Int, dateWindow(days))]);

  const row = result.recordsets[0][0];
  return {
    days: dateWindow(days),
    totals: {
      leads: Number(row.leads), offerings: Number(row.offerings), ignored: Number(row.ignored),
      openLeads: Number(row.open_leads), pendingPrices: Number(row.pending_prices), analyzedContacts: Number(row.analyzed_contacts),
      tokenInput: Number(row.token_input), tokenOutput: Number(row.token_output), queuedJobs: Number(row.queued_jobs), failedJobs: Number(row.failed_jobs),
    },
    trend: result.recordsets[1].map((point) => ({ date: iso(point.activity_date)?.slice(0, 10), leads: Number(point.leads), offerings: Number(point.offerings), ignored: Number(point.ignored) })),
  };
}

export async function getLeadOpsFacets(days = 30) {
  const result = await query(`
    DECLARE @since datetime2(3)=DATEADD(day,-@days,SYSUTCDATETIME());
    SELECT brand,COUNT_BIG(*) total FROM (
      SELECT brand FROM jje.leads WHERE created_at>=@since AND brand IS NOT NULL
      UNION ALL SELECT brand FROM jje.offerings WHERE created_at>=@since AND brand IS NOT NULL
    ) source GROUP BY brand ORDER BY total DESC,brand;
    SELECT model,COUNT_BIG(*) total FROM (
      SELECT model FROM jje.leads WHERE created_at>=@since AND model IS NOT NULL
      UNION ALL SELECT model FROM jje.offerings WHERE created_at>=@since AND model IS NOT NULL
    ) source GROUP BY model ORDER BY total DESC,model;`, [input('days', sql.Int, dateWindow(days))]);
  return {
    brands: result.recordsets[0].map((row) => ({ value: row.brand, total: Number(row.total) })),
    models: result.recordsets[1].map((row) => ({ value: row.model, total: Number(row.total) })),
  };
}

export async function listLeadOpsItems(options = {}) {
  const type = ITEM_TYPES.has(options.type) ? options.type : 'leads';
  const page = clampInteger(options.page, 1, 1, 1000000);
  const limit = clampInteger(options.limit, 30, 1, 100);
  const offset = (page - 1) * limit;
  let source;

  if (type === 'ignored') {
    source = `
      SELECT analysis.message_analysis_id item_id,analysis.message_analysis_id,message.message_id,message.conversation_id,message.contact_id,
        COALESCE(contact.business_name,contact.profile_name) contact_name,contact.phone_number,contact.wa_id,
        COALESCE(message.text_body,message.caption) source_text,analysis.classification,analysis.confidence,
        NULL brand,NULL model,NULL variant,NULL ram_gb,NULL storage_gb,NULL colors_json,NULL quantity_min,NULL quantity_max,
        NULL price_min,NULL price_max,NULL condition,NULL gst_included,NULL dispatch_location,analysis.status item_status,analysis.created_at
      FROM jje.message_analysis analysis
      INNER JOIN jje.messages message ON message.message_id=analysis.message_id
      INNER JOIN jje.contacts contact ON contact.contact_id=message.contact_id
      WHERE analysis.created_at>=DATEADD(day,-@days,SYSUTCDATETIME()) AND analysis.classification IN ('ignored','unknown')
        AND (@search IS NULL OR COALESCE(message.text_body,message.caption,'') LIKE '%'+@search+'%' OR COALESCE(contact.business_name,contact.profile_name,contact.phone_number,contact.wa_id) LIKE '%'+@search+'%')`;
  } else {
    const table = type === 'leads' ? 'leads' : 'offerings';
    const id = type === 'leads' ? 'lead_id' : 'offering_id';
    const priceMin = type === 'leads' ? 'target_price_min' : 'price_min';
    const priceMax = type === 'leads' ? 'target_price_max' : 'price_max';
    source = `
      SELECT item.${id} item_id,analysis.message_analysis_id,message.message_id,message.conversation_id,message.contact_id,
        COALESCE(contact.business_name,contact.profile_name) contact_name,contact.phone_number,contact.wa_id,
        COALESCE(message.text_body,message.caption) source_text,analysis.classification,analysis.confidence,
        item.brand,item.model,item.variant,item.ram_gb,item.storage_gb,item.colors_json,item.quantity_min,item.quantity_max,
        item.${priceMin} price_min,item.${priceMax} price_max,item.condition,item.gst_included,item.dispatch_location,item.status item_status,item.created_at
      FROM jje.${table} item
      INNER JOIN jje.message_analysis analysis ON analysis.message_analysis_id=item.message_analysis_id
      INNER JOIN jje.messages message ON message.message_id=analysis.message_id
      INNER JOIN jje.contacts contact ON contact.contact_id=message.contact_id
      WHERE item.created_at>=DATEADD(day,-@days,SYSUTCDATETIME())
        AND (@brand IS NULL OR item.brand=@brand) AND (@model IS NULL OR item.model=@model) AND (@status IS NULL OR item.status=@status)
        AND (@minPrice IS NULL OR COALESCE(item.${priceMax},item.${priceMin})>=@minPrice)
        AND (@maxPrice IS NULL OR COALESCE(item.${priceMin},item.${priceMax})<=@maxPrice)
        AND (@minQuantity IS NULL OR COALESCE(item.quantity_max,item.quantity_min)>=@minQuantity)
        AND (@search IS NULL OR COALESCE(message.text_body,message.caption,'') LIKE '%'+@search+'%' OR COALESCE(contact.business_name,contact.profile_name,contact.phone_number,contact.wa_id) LIKE '%'+@search+'%' OR item.brand LIKE '%'+@search+'%' OR item.model LIKE '%'+@search+'%')`;
  }

  const result = await query(`
    SELECT COUNT_BIG(*) total FROM (${source}) filtered;
    SELECT * FROM (${source}) filtered ORDER BY created_at DESC,item_id DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`, [
    ...itemFilters(options), input('offset', sql.Int, offset), input('limit', sql.Int, limit),
  ]);
  const total = Number(result.recordsets[0][0].total);
  return { items: result.recordsets[1].map((row) => itemPage(row, type.slice(0, -1))), page, limit, total, totalPages: Math.ceil(total / limit) };
}

export async function getLeadMatches(leadId, limit = 20) {
  const result = await query(`
    DECLARE @brand nvarchar(100),@model nvarchar(160),@ram int,@storage int,@priceMin decimal(19,4),@priceMax decimal(19,4),@quantity int,@condition varchar(30),@variant nvarchar(160),@account bigint;
    SELECT @brand=lead.brand,@model=lead.model,@ram=lead.ram_gb,@storage=lead.storage_gb,@priceMin=lead.target_price_min,@priceMax=lead.target_price_max,
      @quantity=COALESCE(lead.quantity_min,lead.quantity_max),@condition=lead.condition,@variant=lead.variant,@account=number.business_account_id
      FROM jje.leads lead INNER JOIN jje.message_analysis own_analysis ON own_analysis.message_analysis_id=lead.message_analysis_id
      INNER JOIN jje.messages own_message ON own_message.message_id=own_analysis.message_id
      INNER JOIN jje.phone_numbers number ON number.phone_number_id=own_message.phone_number_id WHERE lead.lead_id=@leadId;
    IF @@ROWCOUNT=0 THROW 50001,'Lead not found.',1;
    SELECT TOP (@limit) offering.offering_id item_id,analysis.message_analysis_id,message.message_id,message.conversation_id,message.contact_id,
      COALESCE(contact.business_name,contact.profile_name) contact_name,contact.phone_number,contact.wa_id,
      COALESCE(message.text_body,message.caption) source_text,analysis.classification,analysis.confidence,
      offering.brand,offering.model,offering.variant,offering.ram_gb,offering.storage_gb,offering.colors_json,offering.quantity_min,offering.quantity_max,
      offering.price_min,offering.price_max,offering.condition,offering.gst_included,offering.dispatch_location,offering.status item_status,offering.created_at,
      CASE WHEN case_record.availability_confirmed_at>DATEADD(hour,-24,SYSUTCDATETIME()) AND offering.price_min IS NOT NULL AND COALESCE(offering.quantity_max,offering.quantity_min) IS NOT NULL THEN 0 ELSE 1 END provisional,
      (CASE WHEN @brand IS NOT NULL AND LOWER(offering.brand)=LOWER(@brand) THEN 40 ELSE 0 END
       +CASE WHEN @model IS NOT NULL AND LOWER(offering.model)=LOWER(@model) THEN 30 WHEN @model IS NOT NULL AND (LOWER(offering.model) LIKE '%'+LOWER(@model)+'%' OR LOWER(@model) LIKE '%'+LOWER(offering.model)+'%') THEN 15 ELSE 0 END
       +CASE WHEN @ram IS NOT NULL AND offering.ram_gb=@ram THEN 10 ELSE 0 END
       +CASE WHEN @storage IS NOT NULL AND offering.storage_gb=@storage THEN 10 ELSE 0 END
       +CASE WHEN (@priceMax IS NULL OR offering.price_min IS NULL OR offering.price_min<=@priceMax) AND (@priceMin IS NULL OR offering.price_max IS NULL OR offering.price_max>=@priceMin) THEN 10 ELSE 0 END) match_score
    FROM jje.offerings offering
    INNER JOIN jje.message_analysis analysis ON analysis.message_analysis_id=offering.message_analysis_id
    INNER JOIN jje.messages message ON message.message_id=analysis.message_id
    INNER JOIN jje.contacts contact ON contact.contact_id=message.contact_id
    INNER JOIN jje.phone_numbers number ON number.phone_number_id=message.phone_number_id
    LEFT JOIN jje.agent_cases case_record ON case_record.kind='offering' AND case_record.record_id=offering.offering_id
    WHERE @model IS NOT NULL AND @quantity>0 AND number.business_account_id=@account
      AND LOWER(offering.model)=LOWER(@model) AND offering.status NOT IN ('sold','archived')
      AND (@brand IS NULL OR offering.brand IS NULL OR LOWER(offering.brand)=LOWER(@brand))
      AND (@variant IS NULL OR offering.variant IS NULL OR LOWER(offering.variant)=LOWER(@variant))
      AND (@ram IS NULL OR offering.ram_gb IS NULL OR offering.ram_gb=@ram)
      AND (@storage IS NULL OR offering.storage_gb IS NULL OR offering.storage_gb=@storage)
      AND (@condition IS NULL OR @condition='unknown' OR offering.condition IS NULL OR offering.condition='unknown' OR offering.condition=@condition)
      AND (COALESCE(offering.quantity_max,offering.quantity_min) IS NULL OR COALESCE(offering.quantity_max,offering.quantity_min)>=@quantity)
      AND (@priceMax IS NULL OR offering.price_min IS NULL OR offering.price_min<=@priceMax)
      AND (case_record.case_id IS NULL OR (case_record.control='active' AND case_record.state NOT IN ('closed','cancelled') AND COALESCE(JSON_VALUE(case_record.fields_json,'$.availability'),'unverified')<>'unavailable'))
    ORDER BY match_score DESC,offering.created_at DESC;`, [input('leadId', sql.BigInt, leadId), input('limit', sql.Int, clampInteger(limit, 20, 1, 100))]);
  return result.recordset.map((row) => ({ ...itemPage(row, 'offering'), matchScore: Number(row.match_score),provisional:Boolean(row.provisional) }));
}

async function updateStatus(table, idColumn, id, status, allowed,userId=null) {
  if (!allowed.has(status)) {
    const error = new Error(`Invalid status. Allowed values: ${[...allowed].join(', ')}.`);
    error.statusCode = 400;
    error.code = 'INVALID_LEADOPS_STATUS';
    throw error;
  }
  const entityType = table === 'leads' ? 'lead' : 'offering';
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @updated TABLE(id bigint,status varchar(30),updated_at datetime2(3));
    UPDATE jje.${table} SET status=@status,updated_at=SYSUTCDATETIME()
      OUTPUT inserted.${idColumn},inserted.status,inserted.updated_at INTO @updated
      WHERE ${idColumn}=@id;
    IF NOT EXISTS(SELECT 1 FROM @updated)
    BEGIN
      ROLLBACK TRANSACTION;
      SELECT id,status,updated_at FROM @updated;
      RETURN;
    END;
    UPDATE jje.agent_cases SET version=version+1,updated_at=SYSUTCDATETIME(),
      state=CASE WHEN @status IN ('sold','archived','closed') THEN 'closed' ELSE state END,
      control=CASE WHEN @status='matched' THEN 'handover' ELSE control END,
      fields_json=CASE WHEN @status='sold' THEN JSON_MODIFY(fields_json,'$.availability','unavailable') ELSE fields_json END,
      protected_fields_json=CASE WHEN @status='sold' AND NOT EXISTS(SELECT 1 FROM OPENJSON(protected_fields_json) WHERE value='availability') THEN JSON_MODIFY(protected_fields_json,'append $','availability') ELSE protected_fields_json END
      WHERE kind=@entityType AND record_id=@id;
    UPDATE a SET status='superseded',version=a.version+1,updated_at=SYSUTCDATETIME() FROM jje.agent_actions a
      INNER JOIN jje.agent_cases c ON c.case_id=a.case_id WHERE c.kind=@entityType AND c.record_id=@id AND a.status IN('pending','approved','shadow','blocked');
    INSERT jje.agent_reviews(case_id,user_id,actor_key,decision,snapshot_json) SELECT case_id,@user,@actor,'record_status',
      (SELECT @status status FOR JSON PATH,WITHOUT_ARRAY_WRAPPER) FROM jje.agent_cases WHERE kind=@entityType AND record_id=@id AND @actor IS NOT NULL;
    INSERT jje.outbox_events(event_type,aggregate_type,aggregate_id,payload_json)
      VALUES('leadops.status_changed',@entityType,@id,
        (SELECT @entityType entityType,@id entityId,@status status FOR JSON PATH,WITHOUT_ARRAY_WRAPPER));
    COMMIT TRANSACTION;
    SELECT id,status,updated_at FROM @updated;`, [
    input('id', sql.BigInt, id), input('status', sql.VarChar(30), status),
    input('entityType', sql.VarChar(60), entityType),
    input('user',sql.BigInt,actorUserId(userId)),input('actor',sql.VarChar(100),userId==null?null:actorKey(userId)),
  ]);
  if (!result.recordset[0]) {
    const error = new Error('Item not found.'); error.statusCode = 404; error.code = 'LEADOPS_ITEM_NOT_FOUND'; throw error;
  }
  return { id: Number(result.recordset[0].id), status: result.recordset[0].status, updatedAt: iso(result.recordset[0].updated_at) };
}

export const updateLeadStatus = (id, status,userId) => updateStatus('leads', 'lead_id', id, status, LEAD_STATUSES,userId);
export const updateOfferingStatus = (id, status,userId) => updateStatus('offerings', 'offering_id', id, status, OFFERING_STATUSES,userId);
