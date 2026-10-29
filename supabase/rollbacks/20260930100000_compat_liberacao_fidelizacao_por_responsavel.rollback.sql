-- ROLLBACK de 20260930100000_compat_liberacao_fidelizacao_por_responsavel.sql
--
-- Mesmo timestamp da migration que desfaz, por convencao deste diretorio.
-- `supabase/rollbacks/` e auxiliar: o `supabase db push` NAO le esta pasta.
--
-- UMA LINHA. A migration cria exatamente um objeto e nao altera nada existente,
-- entao desfazer e dropar esse objeto. Nao ha estado a restaurar, nao ha ordem
-- de dependencia a respeitar, nao ha dado a preservar.
--
-- O QUE CONTINUA EXATAMENTE COMO ESTAVA -- porque nunca foi tocado:
--   public.liberar_fidelizacao_caso          md5 1c00df7f23b6c93161ddceab1e8bfbcc
--   public.liberar_casos_fidelizacao_vencida
--   public.casos_elegiveis_liberacao_fidelizacao
--   public.caso_dentro_prazo_fidelizacao
--   internal.matricula_em_fidelizacao
--   cron.job id 8 (fidelizacao_liberar_vencidos, 20 8 * * *)
--   casos.data_ultimo_acionamento, alunos.responsavel_atual_em, historico
--   todas as protecoes
--
-- casos.fidelizacao_inicio e as funcoes fidelizacao_* NAO sao tocadas aqui:
-- pertencem a 20260930090000 e tem rollback proprio.

begin;

drop function if exists internal.liberar_fidelizacao_caso_v2(uuid,text,text);

commit;
