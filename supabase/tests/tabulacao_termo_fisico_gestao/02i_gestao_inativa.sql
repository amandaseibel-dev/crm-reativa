-- AÇÕES do login não privilegiado (app_teste). Preparação e restauração ficam em prep_gestao_inativa_*.sql.
\set ON_ERROR_STOP on
-- Inativo: a RLS de INSERT exige app_usuario_ativo().
select public.teste_assert('gestão inativa: não grava (42501 pela RLS de INSERT)',
  public.teste_comando('authenticated', 'gestao.c@exemplo.local',
    $sql$insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, registrado_por_email)
         values ('a1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','gestao.c@exemplo.local')$sql$)->>'code' = '42501');
