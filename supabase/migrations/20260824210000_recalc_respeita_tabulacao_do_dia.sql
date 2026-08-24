-- Desfecho do operador manda no dia (decisao da gestao, 24/08/2026).
--
-- Problema: ao finalizar o atendimento o frontend grava status, proxima acao e
-- data de retorno em `alunos`. Logo em seguida a movimentacao FINALIZACAO_
-- ATENDIMENTO dispara `fn_atualizar_ultimo_acionamento` -> `recalcular_situacao
-- _aluno`, que reescrevia por cima:
--   * `proxima_acao` virava sempre "cobrar o saldo vencido de R$ X";
--   * `data_retorno` virava HOJE em todo caso com saldo vencido sem data futura.
-- Resultado medido em prod em 24/08/2026: dos 383 casos acionados no dia, 202
-- voltaram pra fila com "retornar hoje" automatico -- como se nao tivessem sido
-- trabalhados. Um caso tabulado como ACORDO_FECHADO exibia "cobrar o saldo
-- vencido".
--
-- Regra nova: se o aluno foi acionado HOJE, o recalculo nao mexe em
-- proxima_acao / data_retorno / retorno_origem de `alunos` -- continua mandando
-- em criticidade, situacao operacional e saldos, que sao fato financeiro.
-- Excecao: quitacao e confirmacao de pagamento superam a tabulacao (o dinheiro
-- entrou; nao adianta o caso seguir com a proxima acao do operador).
-- Na virada do dia (cron de recalculo) o motor volta a mandar sozinho.
--
-- O patch e aplicado sobre a definicao viva da funcao para nao reescrever o
-- corpo inteiro (ela tem ~200 linhas e prod nao espelha o repo). Idempotente:
-- nao faz nada se ja estiver aplicado.
do $patch$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'recalcular_situacao_aluno';

  if v_def is null then
    raise exception 'recalcular_situacao_aluno nao encontrada';
  end if;

  if v_def like '%v_preservar_tabulacao%' then
    raise notice 'patch ja aplicado, nada a fazer';
    return;
  end if;

  -- Rollback: a definicao anterior fica guardada. Para reverter:
  --   do $$ declare d text; begin
  --     select definicao into d from public._backup_funcoes
  --      where funcao='recalcular_situacao_aluno' order by guardado_em desc limit 1;
  --     execute d; end $$;
  create table if not exists public._backup_funcoes(
    id bigserial primary key,
    funcao text not null,
    definicao text not null,
    motivo text,
    guardado_em timestamptz not null default now()
  );
  alter table public._backup_funcoes enable row level security;  -- deny-all: so service_role
  insert into public._backup_funcoes(funcao, definicao, motivo)
  values ('recalcular_situacao_aluno', v_def, 'antes de 20260824210000_recalc_respeita_tabulacao_do_dia');

  -- 1) variavel de controle
  v_def := replace(
    v_def,
    '  v_nivel text; v_situacao text; v_proxima text; v_retorno date; v_origem text;',
    '  v_nivel text; v_situacao text; v_proxima text; v_retorno date; v_origem text;'
    || E'\n  v_preservar_tabulacao boolean := false; v_proxima_auto text;'
  );

  -- 2) preservacao antes de gravar em casos/alunos
  v_def := replace(
    v_def,
    E'  update public.casos set\n     criticidade            = v_nivel,',
    E'  -- Acionado hoje: o desfecho tabulado pelo operador manda na fila.\n'
    || E'  v_proxima_auto := v_proxima;  -- casos.proxima_acao_automatica segue automatica\n'
    || E'  v_preservar_tabulacao := (v_ult_acion = hoje)\n'
    || E'    and v_situacao not in (''QUITADO'',''QUITADO_AGUARDANDO_BAIXA'',''AGUARDANDO_CONFIRMACAO'');\n'
    || E'\n'
    || E'  if v_preservar_tabulacao then\n'
    || E'     select al.proxima_acao, al.data_retorno, al.retorno_origem\n'
    || E'       into v_proxima, v_retorno, v_origem\n'
    || E'       from public.alunos al where al.id = p_aluno_id;\n'
    || E'  end if;\n'
    || E'\n'
    || E'  update public.casos set\n     criticidade            = v_nivel,'
  );

  -- 3) a coluna automatica de `casos` continua guardando a acao do motor,
  --    mesmo quando `alunos.proxima_acao` fica com a tabulacao do operador.
  v_def := replace(
    v_def,
    '     proxima_acao_automatica= v_proxima,',
    '     proxima_acao_automatica= coalesce(v_proxima_auto, v_proxima),'
  );

  if v_def not like '%v_proxima_auto, v_proxima%' then
    raise exception 'patch nao aplicou: marcador de proxima_acao_automatica nao encontrado';
  end if;

  if v_def not like '%v_preservar_tabulacao%' then
    raise exception 'patch nao aplicou: marcadores nao encontrados na definicao';
  end if;

  execute v_def;
end
$patch$;
