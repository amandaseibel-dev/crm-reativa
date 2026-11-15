-- PREPARAÇÃO ADMINISTRATIVA (postgres): fixture de REGISTRO já existente (antes da contenção) + contenção ligada.
\set ON_ERROR_STOP on
insert into public.aluno_movimentacoes (aluno_id, tipo, status_novo, descricao, registrado_por_email)
  values ('c1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','Registro administrativo do termo físico.','amanda.seibel@aelbra.com.br');
\i supabase/aguardando_aprovacao/20261114140000_contencao_registro_termo_fisico.sql.pendente
