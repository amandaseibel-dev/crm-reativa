-- DESFAZER 20260831290000_marcar_titulo_duplicado_pela_ficha.sql
--
-- ATENCAO: a ficha passa a chamar estas duas funcoes. Removendo-as sem voltar o
-- front junto, os botoes "Marcar duplicada" e "Voltar a contar" quebram.
--
-- Os titulos JA marcados como DUPLICADA continuam como estao -- e o valor deles
-- segue fora da conta. Para devolver um titulo especifico antes de remover as
-- funcoes, use `titulo_desfazer_duplicada` enquanto ela ainda existe, ou depois:
--
--   update public.acordos_titulos set situacao='ABERTO', atualizado_em=now()
--    where id = '<id>';
--   select public.recalcular_situacao_aluno('<aluno_id>', 'rollback_duplicada');
--
-- Para achar os marcados por este caminho:
--   select * from public.acordos_titulos
--    where upper(coalesce(situacao,''))='DUPLICADA' and motivo_ajuste like '%marcado DUPLICADA em%';

drop function if exists public.titulo_marcar_duplicada(uuid, text);
drop function if exists public.titulo_desfazer_duplicada(uuid, text);
