-- Rollback de 20260826020000_titulo_acordo_id_alinhado_ao_vinculo.sql
--
-- Devolve `acordo_id` a NULO nos títulos marcados pelo reparo e limpa a
-- anotação. O vínculo em `acordo_titulo_vinculo` NÃO é tocado -- ele já existia
-- antes e continua sendo a fonte da verdade; o reparo só copiou dele.
--
-- Reverter recria o estado de rastreabilidade quebrada (título vinculado que
-- não aponta para o acordo). Só faz sentido se o alinhamento tiver causado
-- algum efeito inesperado em tela ou consulta.

update public.acordos_titulos
   set acordo_id = null,
       motivo_ajuste = nullif(
         btrim(
           regexp_replace(
             coalesce(motivo_ajuste, ''),
             '\s*\|?\s*acordo_id alinhado ao vinculo em 2026-08-26 \(reparo_acordo_id_20260826\)',
             '', 'g'
           ),
           ' |'
         ), ''
       )
 where motivo_ajuste like '%reparo_acordo_id_20260826%';
