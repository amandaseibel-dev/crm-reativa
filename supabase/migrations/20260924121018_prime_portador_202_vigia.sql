-- Vigia do ciclo diario do portador 202, em dois niveis.
--
--   NIVEL 1 (operacional) -- `portador_202_ciclo_diario`
--     As 09h10 UTC o vigia ja consegue afirmar se o ciclo do dia fechou: a
--     coleta e 08h40 e a conferencia 08h55. Falha aparece NO MESMO DIA.
--
--   NIVEL 2 (critico) -- `portador_202_desatualizado_critico`
--     Snapshot sem coleta valida ha mais de 72h: degradacao prolongada.
--
-- O 72h NUNCA LIBERA NADA. Amanda, 24/09/2026: "qualquer futura decisao de
-- reativacao continuara exigindo snapshot completo e com no maximo 24h. O
-- limite de 72h nunca podera liberar titulo ou servir como evidencia de saida
-- do juridico." As 72h existem so para graduar o alerta.
--
-- POR QUE NAO ESTA DENTRO DE `invariantes_rodar`. Aquela funcao tem ~15 KB e
-- um `case` com 29 ramos; reescreve-la inteira para acrescentar dois ramos e
-- justamente o movimento que ja derrubou uma tela em producao (a Projecao, em
-- 11/09/2026, por `create or replace` feito com leitura parcial). O mecanismo
-- E o mesmo: as duas invariantes entram em `invariante_config`, gravam em
-- `invariante_resultado` com a mesma forma (achados/valor/detalhe/duracao) e
-- aparecem no mesmo painel. Nao ha segundo sistema de alerta -- ha uma segunda
-- funcao alimentando o sistema existente.
--
-- A DECISAO E PURA. `prime_portador_202_anomalias` nao consulta tabela nenhuma:
-- recebe os fatos e devolve os motivos. Assim cada cenario -- ciclo bom,
-- snapshot de ontem, disparo sem conclusao, erro de HTTP -- pode ser provado
-- por teste sem depender do estado do banco no momento.

-- 1) A REGRA, PURA.
create or replace function public.prime_portador_202_anomalias(
  p_agora          timestamptz,
  p_ciclo_em       timestamptz,   -- quando o ciclo do dia deveria ter disparado
  p_disparo_em     timestamptz,   -- null = nao houve disparo no ciclo
  p_req_disparo    bigint,
  p_acao_conferencia text,        -- 'CONCLUIDA' | 'FALHOU' | null
  p_req_conferencia  bigint,
  p_motivo_conferencia text,
  p_snapshot       jsonb
)
returns text[]
language plpgsql
immutable
as $function$
declare
  v_motivos text[] := '{}';
  v_coletado timestamptz := nullif(p_snapshot->>'coletado_em','')::timestamptz;
  v_valido boolean := coalesce((p_snapshot->>'valido')::boolean, false);
begin
  -- Antes da hora, nada e cobrado: o vigia pode ser chamado a mao de manha
  -- cedo, e um ciclo que ainda nao chegou nao e uma falha. 20 minutos depois
  -- do disparo ja passou da conferencia (08h55).
  if p_agora < p_ciclo_em + interval '20 minutes' then
    return '{}';
  end if;

  if p_disparo_em is null then
    v_motivos := v_motivos || 'PORTADOR_202_SEM_DISPARO_DIARIO';
  end if;

  if p_acao_conferencia is null then
    v_motivos := v_motivos || 'PORTADOR_202_SEM_CONCLUSAO_DIARIA';
  elsif p_acao_conferencia = 'FALHOU' then
    v_motivos := v_motivos || ('PORTADOR_202_CONFERENCIA_FALHOU:' || coalesce(p_motivo_conferencia,'?'));
  end if;

  if not v_valido then
    v_motivos := v_motivos || ('PORTADOR_202_SNAPSHOT_INVALIDO:' || coalesce(p_snapshot->>'motivo','?'));
  elsif v_coletado is null or v_coletado < p_ciclo_em then
    -- O caso traicoeiro: snapshot VALIDO, porem de ontem. Sem esta checagem o
    -- dia falhado passaria por saudavel.
    v_motivos := v_motivos || 'PORTADOR_202_SNAPSHOT_FORA_DO_CICLO';
  end if;

  -- So compara quando os dois existem; ausencia ja foi cobrada acima.
  if p_req_disparo is not null and p_req_conferencia is not null
     and p_req_disparo <> p_req_conferencia then
    v_motivos := v_motivos || 'PORTADOR_202_REQUEST_ID_DIVERGENTE';
  end if;

  return v_motivos;
end;
$function$;

-- MENOR PRIVILEGIO DESDE O NASCIMENTO. O schema `public` deste projeto tem
-- default privileges que concedem EXECUTE a `authenticated`, e uma funcao nova
-- nasce acessivel sem que ninguem tenha decidido isso -- por isso cada papel e
-- revogado por nome, nao so PUBLIC.
--
-- O UNICO chamador e `prime_portador_202_vigia`, que e SECURITY DEFINER com
-- owner `postgres`: a chamada interna e verificada contra o OWNER, entao
-- conceder so a postgres nao quebra a cadeia.
revoke all on function public.prime_portador_202_anomalias(timestamptz, timestamptz, timestamptz, bigint, text, bigint, text, jsonb) from public;
revoke all on function public.prime_portador_202_anomalias(timestamptz, timestamptz, timestamptz, bigint, text, bigint, text, jsonb) from anon;
revoke all on function public.prime_portador_202_anomalias(timestamptz, timestamptz, timestamptz, bigint, text, bigint, text, jsonb) from authenticated;
revoke all on function public.prime_portador_202_anomalias(timestamptz, timestamptz, timestamptz, bigint, text, bigint, text, jsonb) from service_role;
grant execute on function public.prime_portador_202_anomalias(timestamptz, timestamptz, timestamptz, bigint, text, bigint, text, jsonb)
  to postgres;

-- 2) O VIGIA. Coleta os fatos, chama a regra pura e grava no MESMO lugar que
--    as outras invariantes. So leitura -- nao escreve em titulo, acordo,
--    pagamento, fila nem no proprio snapshot.
create or replace function public.prime_portador_202_vigia()
returns table(nome text, achados bigint, valor numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_t timestamptz := clock_timestamp();
  v_ciclo_em timestamptz;
  v_disp_em timestamptz; v_req_disp bigint;
  v_acao_conf text; v_req_conf bigint; v_motivo_conf text;
  v_estado jsonb; v_estado72 jsonb;
  v_motivos text[]; v_n bigint; v_d jsonb;
begin
  -- O ciclo esperado de HOJE: 08h40 UTC, o horario do cron de coleta.
  v_ciclo_em := (date_trunc('day', (now() at time zone 'UTC')) + interval '8 hours 40 minutes')
                at time zone 'UTC';

  select (a.detalhes->>'request_id')::bigint, a.created_at
    into v_req_disp, v_disp_em
    from public.auditoria a
   where a.acao = 'PRIME_PORTADOR_202_COLETA_DISPARADA'
     and a.created_at >= v_ciclo_em
   order by a.created_at desc limit 1;

  select a.detalhes->>'resultado', (a.detalhes->>'request_id')::bigint, a.detalhes->>'motivo'
    into v_acao_conf, v_req_conf, v_motivo_conf
    from public.auditoria a
   where a.acao in ('PRIME_PORTADOR_202_COLETA_CONCLUIDA','PRIME_PORTADOR_202_COLETA_FALHOU')
     and a.created_at >= v_ciclo_em
   order by a.created_at desc limit 1;

  -- 24h: a janela do ciclo. NUNCA 72h aqui -- ver cabecalho.
  v_estado := public.prime_portador_snapshot_estado(202, 24);

  -- NIVEL 1
  if exists (select 1 from public.invariante_config c
              where c.nome = 'portador_202_ciclo_diario' and c.ligado) then
    v_motivos := public.prime_portador_202_anomalias(
      now(), v_ciclo_em, v_disp_em, v_req_disp,
      v_acao_conf, v_req_conf, v_motivo_conf, v_estado);
    v_n := coalesce(cardinality(v_motivos), 0);
    v_d := jsonb_build_object('motivos', to_jsonb(v_motivos), 'ciclo_em', v_ciclo_em,
                              'disparo_em', v_disp_em, 'conferencia', v_acao_conf,
                              'snapshot', v_estado);
    insert into public.invariante_resultado (nome, achados, valor, detalhe, duracao_ms)
    values ('portador_202_ciclo_diario', v_n, null, v_d,
            extract(milliseconds from clock_timestamp() - v_t)::int);
    nome := 'portador_202_ciclo_diario'; achados := v_n; valor := null; return next;
  end if;

  -- NIVEL 2
  if exists (select 1 from public.invariante_config c
              where c.nome = 'portador_202_desatualizado_critico' and c.ligado) then
    v_estado72 := public.prime_portador_snapshot_estado(202, 72);
    if coalesce((v_estado72->>'valido')::boolean, false) then
      v_n := 0; v_d := jsonb_build_object('snapshot', v_estado72);
    else
      -- achados = horas sem coleta valida; sem coleta nenhuma vira 99999, o
      -- mesmo sentinela que `matview_saude_velha` usa.
      v_n := coalesce((v_estado72->>'idade_horas')::bigint, 99999);
      v_d := jsonb_build_object('motivos', to_jsonb(array['PORTADOR_202_DESATUALIZADO_CRITICO']),
                                'snapshot', v_estado72);
    end if;
    insert into public.invariante_resultado (nome, achados, valor, detalhe, duracao_ms)
    values ('portador_202_desatualizado_critico', v_n, null, v_d,
            extract(milliseconds from clock_timestamp() - v_t)::int);
    nome := 'portador_202_desatualizado_critico'; achados := v_n; valor := null; return next;
  end if;
end;
$function$;

-- Quem chama e o cron, como postgres. Nao ha consumidor autenticado: o painel
-- do vigia le `invariante_resultado`, nao executa a funcao.
revoke all on function public.prime_portador_202_vigia() from public;
revoke all on function public.prime_portador_202_vigia() from anon;
revoke all on function public.prime_portador_202_vigia() from authenticated;
grant execute on function public.prime_portador_202_vigia() to postgres, service_role;

-- 3) As duas invariantes entram no catalogo do vigia, como as outras 29.
insert into public.invariante_config (nome, ligado)
values ('portador_202_ciclo_diario', true),
       ('portador_202_desatualizado_critico', true)
on conflict (nome) do nothing;

-- 4) O cron do vigia passa a rodar as duas coisas, na mesma janela de 09h10.
--
-- ATENCAO AO CORPO. O comando deste cron NAO e `select invariantes_rodar()`:
-- e um bloco `do` que consulta `sistema_sob_carga()` e DESISTE quando o banco
-- esta sob carga. Reagendar com um `select` simples apagaria essa protecao sem
-- ninguem perceber -- o vigia passaria a rodar 29 invariantes em cima de um
-- banco ja sofrendo. O bloco e preservado na integra; a unica mudanca e o
-- `perform` novo na ultima linha.
select cron.unschedule('vigia_invariantes_diario')
 where exists (select 1 from cron.job where jobname = 'vigia_invariantes_diario');

select cron.schedule('vigia_invariantes_diario', '10 9 * * *', $cron$
  do $inner$
  declare v_carga jsonb;
  begin
    v_carga := public.sistema_sob_carga();
    if coalesce((v_carga->>'sob_carga')::boolean, false) then return; end if;
    perform public.invariantes_rodar();
    perform public.prime_portador_202_vigia();
  end
  $inner$;
  $cron$);
