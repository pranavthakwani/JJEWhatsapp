/*
  Legacy compatibility notice
  ---------------------------
  WhatsApp business configuration is now stored in the [jje] schema in Kore_Demo.
  Access tokens are encrypted by the application and verify tokens are stored only
  as one-way hashes. Do not add credentials to this file or commit them to source.

  Provision or rotate a number through the application administration workflow.
  Keep actual secrets in the server environment or an approved secret manager.
*/

THROW 51020, 'Plaintext WhatsApp credential seeding is disabled. Use the secure provisioning workflow.', 1;
