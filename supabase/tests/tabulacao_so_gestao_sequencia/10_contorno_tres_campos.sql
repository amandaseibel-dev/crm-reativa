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

-- Contorno: cada tentativa proibida exige 42501 + mensagem EXATA + estado posterior IGUAL ao anterior.
-- Nenhum SEM_ERRO é aceito: se a normalização deixar passar, o teste falha.
do $$
declare
  v_msg constant text := 'Encerrar cobrança (cancelamento, suspensão, jurídico ou antecipação de semestre) é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.';
  v_cols text[] := array['status_atual','status_jornada','status_acionamento'];
  v_var text[] := array[
    'CANCELAMENTO_COBRANCA',
    ' CANCELAMENTO_COBRANCA',
    E'\tCANCELAMENTO_COBRANCA',
    E'CANCELAMENTO_COBRANCA\n',
    E'CANCELAMENTO_COBRANCA\r',
    E'\u200BCANCELAMENTO_COBRANCA',
    E'CANCELAMENTO_COBRANCA\uFEFF',
    E'\u00A0CANCELAMENTO_COBRANCA',
    E'\u3000CANCELAMENTO_COBRANCA',
    'cancelamento_cobranca'];
  c text; v text; r text; antes text; depois text;
begin
  foreach c in array v_cols loop
    foreach v in array v_var loop
      antes := pg_temp.valor(c);
      r := pg_temp.tentar(format('update public.alunos set %I = %L where id = %L', c, v, 'a0000000-0000-0000-0000-000000000042'));
      depois := pg_temp.valor(c);
      if r is distinct from ('42501|' || v_msg) then
        raise exception 'FALHOU contorno %/%: esperado 42501 exato, obtido %', c, v, r; end if;
      if depois is distinct from antes then
        raise exception 'FALHOU contorno %/%: estado mudou (% -> %)', c, v, antes, depois; end if;
    end loop;
  end loop;
end $$;

-- Controle positivo: operador grava CONTATAR (não encerra) e isso passa.
select public.teste_assert('controle positivo: operador grava CONTATAR em status_atual',
  (pg_temp.tentar($sql$update public.alunos set status_atual = 'CONTATAR' where id = 'a0000000-0000-0000-0000-000000000042'$sql$)) = 'SEM_ERRO');
select 'OK 10_contorno_tres_campos' as resultado;
