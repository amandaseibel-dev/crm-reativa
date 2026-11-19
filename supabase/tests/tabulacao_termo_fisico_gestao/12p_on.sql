-- PREPARAÇÃO ADMINISTRATIVA (postgres): fixture de REGISTRO já existente (antes da contenção) + contenção ligada.
\set ON_ERROR_STOP on
insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, descricao, registrado_por_email)
  values ('c1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','Registro administrativo do termo físico.','gestao.titular@exemplo.local');
update public.termo_fisico_contencao set contencao_ativa = true, alterado_em = clock_timestamp(), alterado_por = 'teste_prep' where id;
