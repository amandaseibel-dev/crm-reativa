-- PREMISSA de seguranca/LGPD, fechada em 04/08: toda tabela de backup ou
-- snapshot nasce com RLS ligada e sem politica -- ninguem le pelo aplicativo.
-- Ver [[rls-tabelas-backup-snapshot]] e [[premissa-seguranca-lgpd-obrigatoria]].
--
-- Em 01/09 a auditoria achou 33 de 115 tabelas `_backup%` sem RLS, quase todas
-- criadas na semana anterior, no meio de consertos feitos as pressas. Entre
-- elas `_backup_pagamento_vinculo_nome_20260828` (3.275 linhas),
-- `_backup_unidade_aluno_20260828` (4.641), `_backup_telefone_ddd_duplicado_20260828`
-- (623) e `_backup_contato_antigo_20260828` (491) -- nome, CPF e telefone.
--
-- Esta migration fecha as que existem. As funcoes que criam backup em tempo de
-- execucao (`baixa_por_documento_aplicar`, `acordos_pos_importacao`) passaram a
-- ligar a RLS na propria criacao, para o buraco nao voltar.

do $$
declare r record; n int := 0;
begin
  for r in
    select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'r'
       and c.relname like '\_backup%' and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('revoke all on public.%I from anon, authenticated', r.relname);
    n := n + 1;
  end loop;
  raise notice 'RLS ligada em % tabelas de backup', n;
end $$;
