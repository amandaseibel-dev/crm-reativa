-- MEDICAO DE ACL E DA FUNCAO DE GESTAO -- producao, 14/11/2026
-- SOMENTE LEITURA (so SELECT no catalogo). Base do rollback da migracao 20261114120000.
select jsonb_build_object(
  'acl_relacoes', (select jsonb_agg(jsonb_build_object('relacao', c.relname, 'acl', coalesce(c.relacl::text,'(padrao)'),
                       'security_invoker', coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'off')) order by c.relname)
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('_tmp_fila2','vw_extracao_calibragem','vw_extracao_observabilidade','vw_extracao_validacao_trilha','vw_pagamento_suspeita_pendente','vw_titulo_presenca_historico')),
  'privilegios_expandidos', (select jsonb_agg(jsonb_build_object('relacao', c.relname, 'papel', coalesce(pg_get_userbyid(a.grantee),'PUBLIC'), 'priv', a.privilege_type) order by c.relname, coalesce(pg_get_userbyid(a.grantee),'PUBLIC'), a.privilege_type)
     from pg_class c join pg_namespace n on n.oid=c.relnamespace, lateral aclexplode(c.relacl) a
    where n.nspname='public' and c.relname in ('_tmp_fila2','vw_extracao_calibragem','vw_extracao_observabilidade','vw_extracao_validacao_trilha','vw_pagamento_suspeita_pendente','vw_titulo_presenca_historico')),
  'usuario_e_gestao_definicao', (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='usuario_e_gestao')
) as r;
