-- Rollback de 20260726120000_suspeitas_pagamentos_duplicados.
-- Remove as RPCs e a tabela de triagem. Não afeta pagamentos (nunca foram
-- alterados por esta feature).

BEGIN;

DROP TRIGGER IF EXISTS pagamentos_detectar_suspeita_dup ON public.pagamentos;
DROP FUNCTION IF EXISTS public.trg_detectar_suspeita_duplicidade();
DROP FUNCTION IF EXISTS public.registrar_decisao_suspeita_duplicidade(uuid, text, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.projecao_suspeitas_pagamentos_duplicados();
DROP INDEX IF EXISTS public.idx_pagamentos_numero_parcela_completo;
DROP TABLE IF EXISTS public.suspeitas_pagamento_duplicado;

COMMIT;
