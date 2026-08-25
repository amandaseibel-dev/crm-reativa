-- Confirmação de Pagamento: de ONDE vem a dívida do caso (acordo x mensalidade).
--
-- PROBLEMA (medido em prod 2026-08-25): dos 2.379 casos pendentes na fila de
-- confirmação, 100% estavam com tipo_pagamento NULL (e acordo_id/parcela_id/
-- titulo_id também). Motivo: só o card dedicado "Confirmar pagamento"
-- (ConfirmarPagamento.jsx) grava tipo/alvo. Os três caminhos de TABULAÇÃO
-- (Minha Carteira, ficha do aluno e fila operacional) criam a solicitação com
-- o mínimo -- aluno, operador, motivo -- porque ali o operador não escolhe
-- tipo nenhum, ele só tabula "aguardando baixa". Resultado: o filtro por tipo
-- da fila nunca devolvia nada.
--
-- SOLUÇÃO: NÃO inventar um "tipo informado" que o operador não informou.
-- Grava-se um campo NOVO e separado, `origem_divida`, DERIVADO do saldo real
-- do aluno no momento em que a solicitação nasce:
--   ACORDO               -> só parcelas de acordo em aberto
--   MENSALIDADE          -> só títulos/mensalidades em aberto
--   ACORDO_E_MENSALIDADE -> os dois
--   SEM_SALDO            -> nada em aberto (candidato a saldo zero)
-- `tipo_pagamento` continua significando exatamente o que sempre significou:
-- o que o OPERADOR informou. Os dois convivem.
--
-- Fonte da verdade do saldo: public.aluno_saldo_pendente_detalhe (mesma regra
-- usada pela quitação, pelo saldo zero e pela fila) -- aqui NÃO se redefine
-- saldo, só se lê.
--
-- Escopo: coluna + função de derivação + trigger BEFORE INSERT + RPC de
-- re-carimbo + backfill dos casos ABERTOS. NÃO altera status, valores,
-- carteira, filas, permissões ou qualquer fluxo financeiro.
-- Idempotente. Rollback: supabase/rollbacks/20260825140000_confirmacao_origem_divida.rollback.sql

------------------------------------------------------------------------------
-- 1) Coluna derivada
------------------------------------------------------------------------------
alter table public.solicitacoes_confirmacao_pagamento
  add column if not exists origem_divida text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'solic_conf_pagto_origem_divida_chk') then
    alter table public.solicitacoes_confirmacao_pagamento
      add constraint solic_conf_pagto_origem_divida_chk
      check (origem_divida is null or origem_divida = any (array[
        'ACORDO','MENSALIDADE','ACORDO_E_MENSALIDADE','SEM_SALDO'
      ]));
  end if;
end $$;

comment on column public.solicitacoes_confirmacao_pagamento.origem_divida is
  'DERIVADO do saldo real do aluno no insert (aluno_saldo_pendente_detalhe). Não é o que o operador informou -- isso é tipo_pagamento.';

-- Filtro da fila é sempre "abertas + origem": índice parcial só do que a tela lê.
create index if not exists idx_solic_conf_origem_divida_aberta
  on public.solicitacoes_confirmacao_pagamento (origem_divida)
  where status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');

------------------------------------------------------------------------------
-- 2) Derivação (regra única, reusa o saldo canônico)
------------------------------------------------------------------------------
create or replace function public.crm_origem_divida_do_aluno(p_aluno_id uuid)
  returns text
  language plpgsql
  stable
  security definer
  set search_path to 'public'
as $function$
declare
  v jsonb;
  v_acordo boolean;
  v_mensal boolean;
begin
  if p_aluno_id is null then
    return null;
  end if;

  v := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);

  -- Parcelas de acordo em aberto (qtd, não valor: parcela de valor 0 ainda é acordo).
  v_acordo := coalesce((v->>'parcelas_abertas_qtd')::int, 0) > 0;
  -- Mensalidades/títulos: abertos + negociados órfãos (mesma soma do saldo canônico).
  v_mensal := (coalesce((v->>'titulos_abertos')::numeric, 0)
             + coalesce((v->>'titulos_negociados_orfaos')::numeric, 0)) > 0.005;

  if v_acordo and v_mensal then return 'ACORDO_E_MENSALIDADE'; end if;
  if v_acordo               then return 'ACORDO';               end if;
  if v_mensal               then return 'MENSALIDADE';          end if;
  return 'SEM_SALDO';
end;
$function$;

revoke all on function public.crm_origem_divida_do_aluno(uuid) from public, anon;
grant execute on function public.crm_origem_divida_do_aluno(uuid) to authenticated, service_role;

-- Resolucao do aluno da SOLICITACAO: 437 dos 2.374 casos abertos em prod
-- (2026-08-25) nasceram SEM aluno_id -- so com CPF. Sem fallback eles ficariam
-- todos sem classificacao. O fallback so vale quando o CPF resolve para
-- EXATAMENTE UM aluno: CPF ambiguo nao classifica nada (fica nulo).
create or replace function public.crm_origem_divida_solicitacao(p_aluno_id text, p_cpf text)
  returns text
  language plpgsql
  stable
  security definer
  set search_path to 'public'
as $function$
declare
  v_id  uuid;
  v_cpf text;
  v_qtd int;
begin
  begin
    v_id := nullif(btrim(coalesce(p_aluno_id, '')), '')::uuid;
  exception when others then
    v_id := null;
  end;

  if v_id is null then
    v_cpf := nullif(lpad(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), 11, '0'), '00000000000');
    if v_cpf is null then
      return null;
    end if;
    -- min(uuid) nao existe no Postgres: agrega em array e pega o primeiro.
    select count(*), (array_agg(a.id))[1] into v_qtd, v_id
      from public.alunos a
     where lpad(regexp_replace(coalesce(a.cpf, ''), '\D', '', 'g'), 11, '0') = v_cpf;
    if v_qtd <> 1 then
      return null;   -- CPF sem aluno ou com mais de um: nao arrisca palpite
    end if;
  end if;

  return public.crm_origem_divida_do_aluno(v_id);
end;
$function$;

revoke all on function public.crm_origem_divida_solicitacao(text, text) from public, anon;
grant execute on function public.crm_origem_divida_solicitacao(text, text) to authenticated, service_role;

------------------------------------------------------------------------------
-- 3) Carimbo no nascimento da solicitação
--    BEFORE INSERT, e NUNCA derruba o insert: se a derivação falhar, a
--    solicitação entra na fila com origem_divida nula (a fila continua
--    funcionando; a RPC do item 4 recarimba depois).
------------------------------------------------------------------------------
create or replace function public.tg_confirmacao_origem_divida()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
begin
  if NEW.origem_divida is not null then
    return NEW;
  end if;
  begin
    NEW.origem_divida := public.crm_origem_divida_solicitacao(NEW.aluno_id, NEW.aluno_cpf);
  exception when others then
    NEW.origem_divida := null;   -- nunca bloqueia a entrada na fila
  end;
  return NEW;
end;
$function$;

-- Funcao de trigger NAO e RPC: sem este revoke ela nasce executavel por
-- public (anon inclusive) como SECURITY DEFINER, e o advisor de seguranca
-- acusa. Chamar direto ja falharia ("trigger functions can only be called as
-- triggers"), mas nao se deixa a porta destrancada.
revoke all on function public.tg_confirmacao_origem_divida() from public, anon, authenticated;

drop trigger if exists trg_confirmacao_origem_divida on public.solicitacoes_confirmacao_pagamento;
create trigger trg_confirmacao_origem_divida
  before insert on public.solicitacoes_confirmacao_pagamento
  for each row
  execute function public.tg_confirmacao_origem_divida();

------------------------------------------------------------------------------
-- 4) Re-carimbo dos ABERTOS (o saldo do aluno muda enquanto o caso espera).
--    Só toca em solicitações ABERTAS e só na coluna origem_divida.
------------------------------------------------------------------------------
create or replace function public.recarimbar_origem_divida_pendentes(p_limite int default 5000)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_qtd int := 0;
begin
  if not public.usuario_e_gestao_fila() then
    raise exception 'Usuário não autorizado.' using errcode = '42501';
  end if;

  with alvo as (
    select s.id, s.aluno_id, s.aluno_cpf
    from public.solicitacoes_confirmacao_pagamento s
    where s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
    order by s.criado_em desc
    limit greatest(coalesce(p_limite, 5000), 0)
  ), novo as (
    select a.id, public.crm_origem_divida_solicitacao(a.aluno_id, a.aluno_cpf) origem
    from alvo a
  )
  update public.solicitacoes_confirmacao_pagamento s
     set origem_divida = n.origem
    from novo n
   where s.id = n.id
     and s.origem_divida is distinct from n.origem;
  get diagnostics v_qtd = row_count;

  return jsonb_build_object('atualizadas', v_qtd);
end;
$function$;

revoke all on function public.recarimbar_origem_divida_pendentes(int) from public, anon;
grant execute on function public.recarimbar_origem_divida_pendentes(int) to authenticated, service_role;

------------------------------------------------------------------------------
-- 5) Backfill dos casos ABERTOS já existentes (histórico fechado fica como está:
--    o saldo de hoje não descreve o caso de meses atrás).
------------------------------------------------------------------------------
update public.solicitacoes_confirmacao_pagamento s
   set origem_divida = public.crm_origem_divida_solicitacao(s.aluno_id, s.aluno_cpf)
 where s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
   and s.origem_divida is null;
