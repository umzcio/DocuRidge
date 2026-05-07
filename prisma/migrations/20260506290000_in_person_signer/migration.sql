-- In-person signer recipient role — host model where the sender hands the
-- device to a person standing next to them. Routing-equivalent to SIGNER
-- for v1; v1.1 adds the dedicated host UI.
ALTER TYPE "RecipientRole" ADD VALUE 'IN_PERSON_SIGNER';
