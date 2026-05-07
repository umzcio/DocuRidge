-- Witness recipient role — signs as a legal observer alongside the primary
-- signer. Routing-equivalent to SIGNER; the role label distinguishes audit
-- entries and email copy.
ALTER TYPE "RecipientRole" ADD VALUE 'WITNESS';
