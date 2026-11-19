-- Variante DEFENSIVA (não é a configuração medida em produção, que é NOINHERIT — ver
-- docs/seguranca/evidencias/medicao_authenticator_20261115.md). Login INHERIT, membro de authenticated:
-- herda privilégios de INSERT sem SET ROLE. A autorização tem de continuar fechada.
-- Execução: papel app_teste_inh (LOGIN INHERIT), criado pelo CI.
\set ON_ERROR_STOP on
create or replace function pg_temp.negado(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql; return 'SEM_ERRO';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || '|' || v_msg;
end $$;
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', false);
do $$
declare r text; n0 int; n1 int;
begin
  select count(*) into n0 from public.aluno_movimentacoes;
  r := pg_temp.negado($sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
       values ('r9','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_ARQUIVADO','operador.teste@exemplo.local')$sql$);
  if r not like '42501|Registro administrativo é restrito à gestão. Nada foi gravado.%' then
    raise exception 'FALHOU INHERIT sem SET ROLE: %', r; end if;
  select count(*) into n1 from public.aluno_movimentacoes;
  if n0 <> n1 then raise exception 'FALHOU INHERIT: linha gravada apesar da recusa'; end if;
end $$;
select 'OK 10_login_inherit_defensivo' as resultado;
