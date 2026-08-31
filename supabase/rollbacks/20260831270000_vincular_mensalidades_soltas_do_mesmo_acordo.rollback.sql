-- DESFAZER 20260831270000_vincular_mensalidades_soltas_do_mesmo_acordo.sql
--
-- ATENCAO: devolve R$ 7.495,36 de divida a quatro alunos cujo acordo ja levou as
-- demais mensalidades. Eles voltam a aparecer devendo e podem ser cobrados de
-- novo pelo que o acordo ja cobria.

delete from public.acordo_titulo_vinculo
 where titulo_id in (select id from public._backup_vinculo_soltas_20260831)
   and vinculado_por = 'ajuste 31/08: sobrou de um acordo que ja levou as outras';

update public.acordos_titulos t
   set acordo_id     = b.acordo_id,
       situacao      = b.situacao,
       status        = b.status,
       vinculado_em  = b.vinculado_em,
       vinculado_por = b.vinculado_por,
       motivo_ajuste = b.motivo_ajuste,
       atualizado_em = now()
  from public._backup_vinculo_soltas_20260831 b
 where t.id = b.id;

-- e recalcular:
-- select public.recalcular_situacao_aluno(aluno_id, 'rollback_vinculo_soltas')
--   from (select distinct aluno_id from public._backup_vinculo_soltas_20260831) x;
