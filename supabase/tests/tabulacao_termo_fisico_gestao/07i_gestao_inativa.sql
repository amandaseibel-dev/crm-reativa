-- AÇÕES do login não privilegiado (app_teste). Preparação e restauração ficam em prep_gestao_inativa_*.sql.
\set ON_ERROR_STOP on
-- Gestão desativada: a operação também deve recusar (o owner ignora RLS dentro da função DEFINER).
select public.teste_assert('operação negada: gestão inativa (42501)',
  public.teste_comando('authenticated','cobranca07@aelbra.com.br',
    $sql$select public.registrar_administrativo_termo_fisico('a0000000-0000-0000-0000-000000000042','TERMO_FISICO_ARQUIVADO')$sql$)->>'code' = '42501');
