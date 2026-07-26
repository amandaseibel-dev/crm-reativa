-- BACKFILL OPCIONAL (NÃO aplicado nesta etapa) — reversível.
-- -----------------------------------------------------------------------------
-- A Edge Function `documento-financeiro-url` já aceita TANTO a URL pública legada
-- QUANTO o caminho interno, portanto este backfill é OPCIONAL (higiene de dados).
-- Converte a URL pública gravada -> caminho interno, só nos casos INEQUÍVOCOS
-- (padrão `/object/public/<bucket>/<caminho>`), preservando backup reversível.
-- NÃO apaga objetos. NÃO altera registros ambíguos (outras URLs, NULL, base64).
--
-- Diagnóstico (produção, 2026-07-26):
--   links_pagamento.comprovante_url : 228 preenchidos, 228 URLs públicas
--   baixas_pagamento.comprovante_url:  30 preenchidos, 30 já caminho interno (não mexer)
--   termos_acordo.arquivo_url       : 314 preenchidos, 314 URLs públicas
--   (arquivo_rg_url / arquivo_verso_url seguem o mesmo padrão quando presentes)
--   casos.termo_url                 :   0 preenchidos

BEGIN;

-- Backup reversível dos valores originais.
CREATE TABLE IF NOT EXISTS public._backup_docfin_urls_20260726 (
  tabela       text,
  registro_id  uuid,
  coluna       text,
  valor_antigo text,
  criado_em    timestamptz DEFAULT now()
);

-- === COMPROVANTES: links_pagamento.comprovante_url ===
INSERT INTO public._backup_docfin_urls_20260726 (tabela, registro_id, coluna, valor_antigo)
SELECT 'links_pagamento', id, 'comprovante_url', comprovante_url
  FROM public.links_pagamento
 WHERE comprovante_url LIKE '%/object/public/comprovantes-pagamento/%';

UPDATE public.links_pagamento
   SET comprovante_url = regexp_replace(
         regexp_replace(comprovante_url, '\?.*$', ''),
         '^.*/object/public/comprovantes-pagamento/', '')
 WHERE comprovante_url LIKE '%/object/public/comprovantes-pagamento/%';

-- === TERMOS: termos_acordo.arquivo_url / arquivo_rg_url / arquivo_verso_url ===
INSERT INTO public._backup_docfin_urls_20260726 (tabela, registro_id, coluna, valor_antigo)
SELECT 'termos_acordo', id, 'arquivo_url', arquivo_url
  FROM public.termos_acordo WHERE arquivo_url LIKE '%/object/public/termos-acordo/%'
UNION ALL
SELECT 'termos_acordo', id, 'arquivo_rg_url', arquivo_rg_url
  FROM public.termos_acordo WHERE arquivo_rg_url LIKE '%/object/public/termos-acordo/%'
UNION ALL
SELECT 'termos_acordo', id, 'arquivo_verso_url', arquivo_verso_url
  FROM public.termos_acordo WHERE arquivo_verso_url LIKE '%/object/public/termos-acordo/%';

UPDATE public.termos_acordo
   SET arquivo_url = regexp_replace(regexp_replace(arquivo_url, '\?.*$', ''), '^.*/object/public/termos-acordo/', '')
 WHERE arquivo_url LIKE '%/object/public/termos-acordo/%';
UPDATE public.termos_acordo
   SET arquivo_rg_url = regexp_replace(regexp_replace(arquivo_rg_url, '\?.*$', ''), '^.*/object/public/termos-acordo/', '')
 WHERE arquivo_rg_url LIKE '%/object/public/termos-acordo/%';
UPDATE public.termos_acordo
   SET arquivo_verso_url = regexp_replace(regexp_replace(arquivo_verso_url, '\?.*$', ''), '^.*/object/public/termos-acordo/', '')
 WHERE arquivo_verso_url LIKE '%/object/public/termos-acordo/%';

COMMIT;

-- --- REVERSÃO DO BACKFILL (se necessário) ---
-- BEGIN;
--   UPDATE public.links_pagamento t
--      SET comprovante_url = b.valor_antigo
--     FROM public._backup_docfin_urls_20260726 b
--    WHERE b.tabela='links_pagamento' AND b.coluna='comprovante_url' AND b.registro_id=t.id;
--   UPDATE public.termos_acordo t
--      SET arquivo_url = b.valor_antigo
--     FROM public._backup_docfin_urls_20260726 b
--    WHERE b.tabela='termos_acordo' AND b.coluna='arquivo_url' AND b.registro_id=t.id;
--   UPDATE public.termos_acordo t
--      SET arquivo_rg_url = b.valor_antigo
--     FROM public._backup_docfin_urls_20260726 b
--    WHERE b.tabela='termos_acordo' AND b.coluna='arquivo_rg_url' AND b.registro_id=t.id;
--   UPDATE public.termos_acordo t
--      SET arquivo_verso_url = b.valor_antigo
--     FROM public._backup_docfin_urls_20260726 b
--    WHERE b.tabela='termos_acordo' AND b.coluna='arquivo_verso_url' AND b.registro_id=t.id;
-- COMMIT;
