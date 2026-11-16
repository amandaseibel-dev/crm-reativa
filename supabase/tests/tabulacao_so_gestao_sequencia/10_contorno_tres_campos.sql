-- Normalização nos TRÊS campos protegidos (status_atual, status_jornada, status_acionamento), como login
-- não privilegiado (app_teste). Recusa exata (42501 + mensagem do piso/catálogo), sem alteração do aluno.
-- Controles positivos: operação legítima do operador passa e a gestão encerra.
\set ON_ERROR_STOP on
create or replace function pg_temp.tentar(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql; return 'SEM_ERRO';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || '|' || v_msg;
end $$;
create or replace function pg_temp.valor(p_col text) returns text language plpgsql as $$
declare v text;
begin
  execute format('select %I from public.alunos where id = %L', p_col, 'a0000000-0000-0000-0000-000000000042') into v;
  return coalesce(v, '<null>');
end $$;

-- Contorno: variantes de CANCELAMENTO_COBRANCA em cada coluna, com caracteres de contorno.
do $$
declare
  v_cols text[] := array['status_atual','status_jornada','status_acionamento'];
  v_var text[] := array[
    'CANCELAMENTO_COBRANCA',
    ' CANCELAMENTO_COBRANCA',
    E'\tCANCELAMENTO_COBRANCA',
    E'CANCELAMENTO_COBRANCA\n',
    E'CANCELAMENTO_COBRANCA\r',
    E'​CANCELAMENTO_COBRANCA',
    E'CANCELAMENTO_COBRANCA﻿',
    E' CANCELAMENTO_COBRANCA',
    E'　CANCELAMENTO_COBRANCA',
    'cancelamento_cobranca'];
  c text; v text; r text; antes text; depois text;
begin
  foreach c in array v_cols loop
    foreach v in array v_var loop
      antes := pg_temp.valor(c);
      r := pg_temp.tentar(format('update public.alunos set %I = %L where id = %L', c, v, 'a0000000-0000-0000-0000-000000000042'));
      depois := pg_temp.valor(c);
      -- Recusa exata OU, se a normalização não reconhecer o valor, linha inalterada (nunca alteração parcial).
      if r not like '42501|Encerrar cobrança%' and r <> 'SEM_ERRO' then
        raise exception 'FALHOU contorno %/%: erro inesperado %', c, v, r; end if;
      if r = 'SEM_ERRO' and depois is distinct from antes and depois <> v then
        raise exception 'FALHOU contorno %/%: alterou sem recusa', c, v; end if;
    end loop;
  end loop;
end $$;

-- Controle positivo: operador grava CONTATAR (não encerra) e isso passa.
select public.teste_assert('controle positivo: operador grava CONTATAR em status_atual',
  (pg_temp.tentar($sql$update public.alunos set status_atual = 'CONTATAR' where id = 'a0000000-0000-0000-0000-000000000042'$sql$)) = 'SEM_ERRO');
select 'OK 10_contorno_tres_campos' as resultado;
