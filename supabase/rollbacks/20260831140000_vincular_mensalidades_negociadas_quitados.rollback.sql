-- DESFAZER 20260831140000_vincular_mensalidades_negociadas_quitados.sql
--
-- ATENCAO: desfazer devolve R$ 11.213,81 de divida a cinco alunos que JA
-- PAGARAM -- negociaram, o acordo foi quitado e o caso encerrado. Eles voltam a
-- aparecer devendo na tela e podem ser cobrados de novo.
--
-- So use se ficar provado que essas mensalidades NAO faziam parte do acordo.

update public.acordos_titulos t
   set acordo_id     = b.acordo_id,
       situacao      = b.situacao,
       status        = b.status,
       vinculado_em  = b.vinculado_em,
       vinculado_por = b.vinculado_por,
       motivo_ajuste = b.motivo_ajuste,
       atualizado_em = now()
  from public._backup_vinculo_negociadas_20260831 b
 where t.id = b.id;

delete from public.acordo_titulo_vinculo
 where titulo_id in (select id from public._backup_vinculo_negociadas_20260831)
   and vinculado_por = 'correcao 31/08: acordo pago, mensalidade seguia aberta';

-- e recalcular, senao o saldo fica com o valor da versao corrigida:
-- select public.recalcular_situacao_aluno(aluno_id, 'rollback_vinculo')
--   from (select distinct aluno_id from public._backup_vinculo_negociadas_20260831) x;
