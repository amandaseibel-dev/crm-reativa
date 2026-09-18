-- ACORDO CANCELADO NAO E COBRANCA CANCELADA
--
-- Quando um acordo era cancelado ou quebrava, `liberar_caso_por_evento` gravava
-- `casos.status_acionamento = 'CANCELADO'`. Esse mesmo valor estava no array de
-- bloqueio de `caso_encerrado_operacional` e de `casos_reabrir_com_divida`, ao
-- lado de JURIDICO e SUSPENSAO COBRANCA. Resultado medido em producao em
-- 17/09/2026: 232 casos com esse valor, NENHUM ativo, e 184 alunos com divida
-- real fora da fila -- R$ 1.535.123,30. O sistema lia "o acordo caiu" como
-- "nao cobre mais esta pessoa", o inverso da premissa de que acordo cancelado
-- devolve a mensalidade para a cobranca.
--
-- `status_acionamento` descreve o ACIONAMENTO, nao a COBRANCA. A correcao tira
-- o poder de bloqueio de 'CANCELADO' SOMENTE nesse campo. Onde 'CANCELADO'
-- significa cobranca cancelada de verdade -- status_atual, status_financeiro,
-- status_jornada -- ele continua bloqueando, e JURIDICO segue bloqueando nos
-- quatro campos (inclusive em status_acionamento, onde o ramo 'JURIDICO' da
-- propria `liberar_caso_por_evento` o grava de proposito).
--
-- Nenhum bloqueio real de cobranca e enfraquecido.

begin;

-- 1. A ORIGEM ---------------------------------------------------------------
-- O evento de cancelamento/quebra de acordo passa a gravar um valor que so
-- fala de acordo. Sem isto, todo acordo cancelado voltaria a fechar o caso e o
-- cron teria de reabri-lo uma hora depois, sujando o historico.
create or replace function public.liberar_caso_por_evento(
  p_aluno_id uuid, p_evento text, p_valor_pago numeric default null::numeric,
  p_data_pagamento date default current_date)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_det jsonb;
begin
  IF p_evento = 'LINK_PAGO' THEN
    v_det := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);
    IF (v_det ->> 'tem_pendencia')::boolean THEN
      insert into public.log_quitacao_bloqueada(aluno_id, origem, saldo_pendente, detalhe)
      values (p_aluno_id, 'LINK_PAGAMENTO', (v_det ->> 'total')::numeric, v_det);
      RETURN;
    END IF;
    UPDATE public.casos
    SET status_financeiro = 'QUITADO_LINK_PAGAMENTO', quitado_em = p_data_pagamento,
        valor_quitado = COALESCE(p_valor_pago, 0), origem_quitacao = 'LINK_PAGAMENTO',
        caso_atualizado_por = 'sistema_link_pagamento', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'CANCELADO' THEN
    -- ANTES: status_acionamento = 'CANCELADO' -- lido como cobranca cancelada.
    -- AGORA: rotulo que so fala de acordo. O caso continua na fila.
    UPDATE public.casos
    SET status_acionamento = 'ACORDO_CANCELADO', caso_atualizado_por = 'sistema_cancelamento_acordo', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
    PERFORM public.retirar_zerados_reais_sem_saldo(p_aluno_id, null);
  ELSIF p_evento = 'JURIDICO' THEN
    UPDATE public.casos
    SET status_acionamento = 'JURIDICO', caso_atualizado_por = 'sistema_juridico', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  ELSIF p_evento = 'ACORDO_MENSALIDADE_LIBERADA' THEN
    UPDATE public.casos
    SET status_acionamento = 'ACORDO FECHADO', caso_atualizado_por = 'sistema_acordo_fechado', caso_atualizado_em = now()
    WHERE aluno_id = p_aluno_id;
  END IF;
end;
$function$;

-- 2. A LEITURA --------------------------------------------------------------
-- `bloq` continua valendo para status_atual, status_financeiro e status_jornada.
-- `bloq_acion` e o mesmo conjunto MENOS 'CANCELADO', e vale so para
-- status_acionamento. JURIDICO e as suspensoes seguem bloqueando nos quatro.
create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text,
  p_status_financeiro text, p_status_jornada text)
returns boolean
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- status_acionamento fala do ACIONAMENTO. 'CANCELADO' aqui e acordo
  -- cancelado, nao cobranca cancelada -- e nao tira ninguem da fila.
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- 3. A CASA DA DECISAO DE NAO COBRAR ----------------------------------------
-- Decisao de gestao de nao cobrar precisa de casa estavel: o reabridor passa a
-- consultar esta tabela, e quem estiver aqui nao volta para a fila por
-- automatismo nenhum. Sair daqui e ato da gestao.
create table if not exists public.cobranca_nao_reabrir (
  cpf text primary key,
  motivo text not null,
  origem text not null,
  registrado_por text not null,
  registrado_em timestamptz not null default now()
);
comment on table public.cobranca_nao_reabrir is
  'CPFs com decisao explicita de nao cobrar. O reabridor automatico nunca os devolve para a fila. Sair daqui e ato da gestao.';

alter table public.cobranca_nao_reabrir enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                  and tablename='cobranca_nao_reabrir' and policyname='cobranca_nao_reabrir_leitura') then
    create policy cobranca_nao_reabrir_leitura on public.cobranca_nao_reabrir
      for select to authenticated using (true);
  end if;
end $$;

-- Semente a partir da lista de trabalho de 10/09 (`_cancelamento_cobranca_20260910`).
--
-- ATENCAO: aquela lista e DIAGNOSTICO, nao decisao. A coluna `motivo` foi
-- derivada do estado do caso naquele dia: "Cancelamento de cobranca" sao os
-- casos com status_acionamento = 'CANCELADO' -- justamente as vitimas do
-- defeito que esta migration corrige. Semear essas linhas trancaria fora da
-- fila quem deve voltar (foi o que aconteceu em producao em 18/09: 13 linhas,
-- 5 alunos presos, removidos no mesmo dia -- ver o ledger 20260918).
-- Por isso so entra o que NAO veio de status_acionamento = 'CANCELADO'.
--
-- A lista so existe em producao. Em qualquer outro ambiente ela nao existe e a
-- semente simplesmente nao roda. `on conflict do nothing` mantem a migration
-- reaplicavel e nao sobrescreve decisao posterior da gestao.
do $$
begin
  if to_regclass('public._cancelamento_cobranca_20260910') is not null then
    execute $semente$
      insert into public.cobranca_nao_reabrir (cpf, motivo, origem, registrado_por)
      select distinct lpad(regexp_replace(coalesce(x.cpf,''), '\D', '', 'g'), 11, '0'),
             coalesce(nullif(trim(x.motivo), ''), 'cancelamento de cobranca'),
             '_cancelamento_cobranca_20260910', 'migracao_20260918000000'
        from public._cancelamento_cobranca_20260910 x
       where regexp_replace(coalesce(x.cpf,''), '\D', '', 'g') <> ''
         and upper(coalesce(x.status_acionamento,'')) <> 'CANCELADO'
      on conflict (cpf) do nothing
    $semente$;
  end if;
end $$;

-- 4. O REABRIDOR ------------------------------------------------------------
-- Mesmo ajuste no v_bloq para status_acionamento, mais duas travas que a
-- funcao nunca teve: `nao_acionar` e a lista de decisao de nao cobrar.
create or replace function public.casos_reabrir_com_divida(p_limite integer default null::integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '180s'
as $function$
declare
  v_bloq text[] := array['JURIDICO','CANCELAMENTO COBRANCA','SUSPENSAO COBRANCA',
                         'SUSPENSAO DE COBRANCA','CANCELADO'];
  -- status_acionamento: 'CANCELADO' aqui e acordo cancelado. Nao bloqueia.
  v_bloq_acion text[] := array['JURIDICO','CANCELAMENTO COBRANCA','SUSPENSAO COBRANCA',
                               'SUSPENSAO DE COBRANCA'];
  v_n integer := 0;
  v_pulados integer := 0;
  v_falhas integer := 0;
  r record;
begin
  for r in
    select c.id, c.aluno_id, c.status_atual as st_ant
      from public.casos c
     where c.aluno_id is not null
       and (coalesce(c.encerrado_operacional, false)
            or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                                 c.status_financeiro, c.status_jornada))
       -- SO reabre quem nao tem NENHUM caso aberto. Sem isto o reabridor
       -- ressuscita a copia duplicada que a fusao acabou de aposentar.
       -- (Continua aqui porque poda a lista cedo; a decisao final e no laco.)
       and not exists (
         select 1 from public.casos c2
          where c2.aluno_id = c.aluno_id and c2.id <> c.id
            and not coalesce(c2.encerrado_operacional, false))
       -- TRAVA NOVA 1. Decisao explicita de nao acionar, gravada no caso.
       and not coalesce(c.nao_acionar, false)
       -- TRAVA NOVA 2. Decisao explicita de nao cobrar, gravada pela gestao.
       and not exists (
         select 1 from public.cobranca_nao_reabrir nr
          where nr.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D', '', 'g'), 11, '0')
            and regexp_replace(coalesce(c.cpf_limpo,''), '\D', '', 'g') <> '')
       and public.normalizar_status_acionamento(coalesce(c.status_atual,''))       <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_acionamento,'')) <> all(v_bloq_acion)
       and public.normalizar_status_acionamento(coalesce(c.status_financeiro,''))  <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_jornada,''))     <> all(v_bloq)
       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'
       and not exists (select 1 from public.alunos al
                        where al.id = c.aluno_id
                          and upper(coalesce(al.status_atual,'')) ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO')
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric > 0.005
     limit coalesce(p_limite, 100000)
  loop
    -- CONSERTO 1. A lista acima e uma fotografia. Se o proprio laco ja devolveu
    -- OUTRO caso deste aluno para a fila, este aqui nao entra: a ficha do aluno
    -- e unica. Mesmo criterio do gatilho _caso_nao_duplica_aluno(), para a
    -- decisao aqui e a trava la nunca discordarem.
    if exists (
      select 1 from public.casos c2
       where c2.aluno_id = r.aluno_id
         and c2.id <> r.id
         and not coalesce(c2.encerrado_operacional, false)
         and public.caso_encerrado_operacional(c2.cpf, c2.status_atual, c2.status_acionamento,
                                               c2.status_financeiro, c2.status_jornada) = false
    ) then
      v_pulados := v_pulados + 1;
      continue;
    end if;

    -- CONSERTO 2. Uma ficha ruim nunca mais leva junto as outras.
    begin
      update public.casos
         set status_atual = 'Em cobrança',
             status_acionamento = null,
             status_jornada = 'Em cobrança',
             status_financeiro = case
               when public.normalizar_status_acionamento(coalesce(status_financeiro,''))
                    in ('QUITADO','PAGO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                        'SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO')
                 then null
               else status_financeiro end,
             -- A LINHA QUE FALTAVA. Sem ela o caso mudava de status mas seguia
             -- fora da fila, e o cron o repescava toda hora, gravando outra
             -- movimentacao de reabertura que nao reabria nada.
             encerrado_operacional = false,
             caso_atualizado_por = 'sistema_reabrir_com_divida',
             caso_atualizado_em = now()
       where id = r.id;

      update public.alunos
         set status_atual = 'Em cobrança',
             status_jornada = 'Em cobrança',
             status_acionamento = null
       where id = r.aluno_id
         and upper(coalesce(status_atual,'')) !~ 'JURIDICO|CANCELAMENTO|SUSPENSAO';

      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo,
         registrado_por_nome, registrado_por_email, registrado_em)
      values (r.aluno_id::text, 'REABERTURA_DIVIDA_NOVA',
              'Caso estava fora da base como "' || coalesce(r.st_ant,'(sem status)')
              || '" mas voltou a ter saldo em aberto. Devolvido para a fila.',
              coalesce(r.st_ant,'(sem)'), 'Em cobrança',
              'Sistema', 'sistema_reabrir_com_divida', now());

      perform public.recalcular_situacao_aluno(r.aluno_id, 'reabrir_com_divida');
      v_n := v_n + 1;
    exception when others then
      v_falhas := v_falhas + 1;
      raise warning 'casos_reabrir_com_divida: caso % do aluno % nao foi reaberto e foi pulado: %',
        r.id, r.aluno_id, sqlerrm;
    end;
  end loop;

  if v_pulados > 0 or v_falhas > 0 then
    raise warning 'casos_reabrir_com_divida: % reaberto(s), % pulado(s) por ja terem caso aberto, % com erro',
      v_n, v_pulados, v_falhas;
  end if;

  return v_n;
end;
$function$;

commit;
