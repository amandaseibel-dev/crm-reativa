-- MANDAR PARA CONFIRMACAO DE PAGAMENTO JA E A TABULACAO -- E SEGURA O CASO
-- ATE A CONFIRMACAO SER CONCLUIDA.
--
-- Amanda, 02/09/2026: "ao enviar o aluno para confirmacao de pagamento seria
-- mais adequado se isso ja automaticamente tabulasse ele como aguardando
-- confirmacao, ao inves de termos que mandar pra confirmacao e tabular
-- tambem" -- "deixe ate a conclusao do caso".
--
-- POR QUE ELA PRECISAVA TABULAR DE NOVO. Mandar para a confirmacao ja movia o
-- aluno para AGUARDANDO_BAIXA (trg_aluno_aguardando_baixa) e ja contava como
-- acionamento. O que estragava era a DATA: `recalcular_situacao_aluno` corre
-- logo em seguida (trg_recalc_conf) e devolvia o caso com retorno = HOJE.
--
--   * ramo AGUARDANDO_CONFIRMACAO -- so vale para quem NAO tem saldo vencido
--     -- ja deixava o caso sem retorno, parado. Este esta certo e nao muda.
--   * ramo COBRANCA_VENCIDA -- o caso comum: pagou uma parcela e o resto
--     segue vencido -- carimbava v_retorno := hoje e a proxima acao "cobrar o
--     saldo vencido de R$ X". O caso voltava marcado "retornar hoje", como se
--     ninguem tivesse trabalhado nele. Ela tabulava por cima so para empurrar.
--
-- MEDIDO EM PROD HOJE (02/09/2026), alunos com confirmacao AGUARDANDO:
--   353 no total
--   318 (90%) com situacao COBRANCA_VENCIDA -- o ramo que carimbava hoje
--   248 com data_retorno = HOJE
--
-- A REGRA QUE ENTRA: enquanto houver confirmacao pendente, o caso NAO tem data
-- de retorno -- fica com a Amanda/Fernanda ate a conferencia ser concluida.
-- Nao ha prazo empurrando ele de volta para o operador. Quando a confirmacao
-- e concluida (confirmada ou rejeitada), o proprio trg_recalc_conf recalcula
-- com v_conf_pend = 0 e o caso volta para a fila no mesmo dia, pelo caminho
-- normal. Situacao, criticidade e saldos seguem como estao: isto mexe SO na
-- data de retorno e na frase da proxima acao, que parava de dizer "cobrar o
-- saldo vencido" de um caso que esta esperando o financeiro.
--
-- A confirmacao pendente tambem passa a superar a "tabulacao do dia"
-- (20260824210000): sem isso o recalculo restaurava a data que o operador
-- tinha deixado na linha e o caso voltava assim mesmo.
--
-- ONDE O CASO NAO SE PERDE: ele continua listado na Fila de Confirmacao de
-- Pagamento (a fila da Amanda/Fernanda) e continua protegido de
-- redistribuicao. Sair da fila do operador nao e sumir.
--
-- O patch e aplicado sobre a definicao viva (mesmo padrao de
-- 20260824210000_recalc_respeita_tabulacao_do_dia): a funcao tem ~200 linhas e
-- prod nao espelha o repo. Idempotente.
--
-- DESFAZER: supabase/rollbacks/20260902130000_confirmacao_segura_o_caso_ate_concluir.rollback.sql

begin;

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

  -- Trava de idempotencia pela FRASE nova, nao por 'v_conf_pend' -- a funcao
  -- ja usava 'and v_conf_pend = 0' no primeiro ramo (saldo zerado), entao um
  -- marcador desses da falso positivo e o patch nao aplica nada.
  if v_def like '%aguardar a confirmação do pagamento no financeiro%' then
    raise notice 'patch ja aplicado, nada a fazer';
    return;
  end if;

  -- Rollback: a definicao anterior fica guardada em _backup_funcoes.
  create table if not exists public._backup_funcoes(
    id bigserial primary key,
    funcao text not null,
    definicao text not null,
    motivo text,
    guardado_em timestamptz not null default now()
  );
  alter table public._backup_funcoes enable row level security;  -- deny-all: so service_role
  insert into public._backup_funcoes(funcao, definicao, motivo)
  values ('recalcular_situacao_aluno', v_def, 'antes de 20260902130000_confirmacao_segura_o_caso_ate_concluir');

  -- 1) Com saldo vencido (90% dos casos): o retorno era HOJE. Passa a nao ter
  --    retorno enquanto a confirmacao nao for concluida. Criticidade e
  --    situacao continuam decididas pelo dinheiro, como hoje.
  v_def := replace(
    v_def,
    E'     if v_acao_massiva and v_ult_acion is not null and (hoje - v_ult_acion) < 10 then',
    E'     if v_conf_pend > 0 then\n'
    || E'        -- Está com o financeiro: o caso fica parado até a conferência ser\n'
    || E'        -- concluída. Sem prazo empurrando ele de volta para o operador.\n'
    || E'        v_proxima := ''Próxima ação: aguardar a confirmação do pagamento no financeiro''\n'
    || E'                  || '' (saldo vencido de ''||public.fmt_brl(v_saldo_vencido)||'' segue em aberto).'';\n'
    || E'        v_retorno := null; v_origem := null;\n'
    || E'     elsif v_acao_massiva and v_ult_acion is not null and (hoje - v_ult_acion) < 10 then'
  );

  -- 2) A confirmação pendente supera a tabulação do dia (20260824210000) --
  --    senão o recálculo restaurava a data que o operador deixou na linha.
  v_def := replace(
    v_def,
    E'  v_preservar_tabulacao := (v_ult_acion = hoje)\n    and v_situacao not in (',
    E'  v_preservar_tabulacao := (v_ult_acion = hoje)\n'
    || E'    and v_conf_pend = 0\n'
    || E'    and v_situacao not in ('
  );

  if v_def not like '%if v_conf_pend > 0 then%' then
    raise exception 'patch nao aplicou: ramo de cobranca vencida nao encontrado';
  end if;

  if v_def not like E'%v_preservar_tabulacao := (v_ult_acion = hoje)\n    and v_conf_pend = 0%' then
    raise exception 'patch nao aplicou: marcador da tabulacao do dia nao encontrado';
  end if;

  execute v_def;
end
$patch$;

-- Quem ja estava na fila da confirmacao entra na regra nova agora (353 alunos
-- em 02/09/2026, 248 deles marcados "retornar hoje").
update public.alunos a
   set data_retorno = null,
       retorno_origem = null
 where a.data_retorno is not null
   and exists (
     select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = a.id::text and s.status = 'AGUARDANDO_CONFIRMACAO');

update public.casos c
   set data_retorno = null
 where c.data_retorno is not null
   and exists (
     select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = c.aluno_id::text and s.status = 'AGUARDANDO_CONFIRMACAO');

commit;
