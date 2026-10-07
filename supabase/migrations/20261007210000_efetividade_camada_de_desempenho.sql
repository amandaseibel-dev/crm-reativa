-- CAMADA DE DESEMPENHO da Efetividade. NAO e um universo novo.
--
-- O PROBLEMA, MEDIDO EM PRODUCAO em 07/10/2026 como `authenticated`, cujo papel
-- tem `statement_timeout = 8s`:
--
--   carteira_2026_1_classificar()                 8.125 ms   (14.979 linhas)
--   carteira_safra_situacoes('2026','1')         11.950 ms frio / 3.697 ms morno
--   carteira_safra_situacoes('2024')              9.890 ms frio / 1.336 ms morno
--
-- `classificar` sozinha JA passa de 8s. Nao e cache frio ocasional: e a linha de
-- base. E cada RPC da tela a executa de novo -- as seis linhas, a composicao
-- academica e as pendencias somam tres execucoes por abertura de 2026/1. Deixar
-- ao vivo e aceitar que a tela cai.
--
-- O QUE ESTA CAMADA E: uma FOTOGRAFIA do que as funcoes OFICIAIS devolvem,
-- guardada VERBATIM. O recalculo chama `carteira_safra_situacoes`,
-- `carteira_em_aberto_por_status_academico` e `carteira_pendencias_por_motivo` e
-- grava o jsonb que elas retornam, sem reprocessar, sem recomputar, sem
-- reagrupar. Nao ha segunda definicao de "em aberto" neste arquivo -- nao ha
-- SELECT sobre `acordos_titulos`, `pagamentos`, `parcelas` nem `alunos`.
-- Trocar a regra em qualquer uma das tres funcoes muda a fotografia no
-- recalculo seguinte, sem tocar aqui.
--
-- O QUE ESTA CAMADA NAO E: nao reintroduz `carteira_academico_universo`, nao
-- recria `carteira_academico_saldo_snapshot` e nao cria universo concorrente
-- algum. Esses foram descartados de proposito.
--
-- POR QUE O RECALCULO PODE DEMORAR E A TELA NAO: a funcao de recalculo declara
-- `set statement_timeout` dela mesma. O teto de 8s do papel `authenticated` e
-- da SESSAO; um `SET` no cabecalho da funcao vale enquanto ela executa e volta
-- ao sair. Assim a gestao consegue disparar "Atualizar dados" pelo navegador, e
-- o cron (que roda como `postgres`, sem teto) atualiza sozinho. A LEITURA da
-- tela e um index scan de uma linha.
--
-- A TRAVA QUE IMPORTA: antes de gravar, o recalculo CONFERE que a soma da
-- composicao academica e identica -- valor, alunos e titulos -- ao balde
-- `em_aberto` das seis linhas do MESMO recorte. Se divergir, ABORTA e nao grava.
-- A tela nao consegue exibir divergencia financeira interna porque a fotografia
-- que a produziria nunca e gravada. Conferido em producao em 07/10/2026, zero de
-- diferenca nos tres recortes.
--
-- A DATA FICA EXPLICITA: a leitura devolve `gerado_em` junto do payload, e a
-- tela mostra. Leitura que deixou de ser ao vivo tem de dizer de quando e.
--
-- ESCOPO: 2024, 2025 e 2026/1, nos tres blocos. 2026/2 nao entra -- as visoes
-- dela usam outro caminho e nao foram tocadas. A lista individual de pendencias
-- (`carteira_pendencias_itens`) continua AO VIVO: ela e o registro que a Fila
-- Unica trata, e trabalhar sobre fotografia seria tratar caso que talvez ja
-- esteja resolvido.

-- ---------------------------------------------------------------- 1. a tabela
create table if not exists public.carteira_efetividade_snapshot (
  recorte     text        not null,            -- '2024' | '2025' | '2026/1'
  bloco       text        not null,            -- 'situacoes' | 'academico' | 'pendencias'
  ano         text        not null,
  semestre    text,
  payload     jsonb       not null,            -- o retorno VERBATIM da funcao oficial
  gerado_em   timestamptz not null default now(),
  duracao_ms  integer,
  -- A MARCA DE DESATUALIZADA. Nulo = fotografia em dia. Quem marca e o gatilho
  -- de statement da migration 20261007230000; quem limpa e o proprio recalculo,
  -- no `on conflict` abaixo.
  invalidada_em  timestamptz,
  invalidada_por text,
  primary key (recorte, bloco),
  constraint carteira_efetividade_snapshot_bloco_ck
    check (bloco in ('situacoes', 'academico', 'pendencias'))
);

comment on table public.carteira_efetividade_snapshot is
  'Camada de desempenho da Efetividade: fotografia verbatim do retorno de carteira_safra_situacoes, carteira_em_aberto_por_status_academico e carteira_pendencias_por_motivo. Nao contem definicao de regra.';

-- Tabela nova herda privilegios amplos do schema public -- inclusive TRUNCATE
-- para authenticated, e RLS nao cobre TRUNCATE. Fecha explicitamente: a tela le
-- pela funcao SECURITY DEFINER, nunca pela tabela.
alter table public.carteira_efetividade_snapshot enable row level security;
revoke all on table public.carteira_efetividade_snapshot from public, anon, authenticated;
grant select, insert, update, delete on table public.carteira_efetividade_snapshot to service_role;

-- ------------------------------------------------------- 2. recalculo (escrita)
create or replace function public.carteira_efetividade_snapshot_recalcular(p_recorte text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
-- O teto de 8s e do papel da SESSAO. Este SET vale so enquanto a funcao roda:
-- e o que permite a gestao disparar o recalculo pelo navegador sem ser cortada
-- no meio e deixar a fotografia pela metade.
set statement_timeout to '240s'
as $function$
declare
  r          record;
  v_t0       timestamptz;
  v_sit      jsonb;
  v_aca      jsonb;
  v_pen      jsonb;
  v_feitos   jsonb := '[]'::jsonb;
begin
  -- Escrita: so service_role (cron) ou a gestao pela tela.
  if not (coalesce(auth.role(),'') = 'service_role'
          or auth.jwt() is null
          or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  -- Dois recalculos ao mesmo tempo gastariam o dobro do banco para gravar a
  -- mesma coisa. O segundo desiste e diz que desistiu, em vez de enfileirar.
  if not pg_try_advisory_xact_lock(hashtext('carteira_efetividade_snapshot')) then
    return jsonb_build_object('ja_em_andamento', true, 'verificado_em', now());
  end if;

  for r in
    select * from (values ('2024','2024',null::text),
                          ('2025','2025',null::text),
                          ('2026/1','2026','1')) v(recorte, ano, semestre)
     where p_recorte is null or v.recorte = p_recorte
  loop
    v_t0 := clock_timestamp();

    -- As TRES funcoes oficiais, chamadas como estao. Nenhum calculo aqui.
    v_sit := public.carteira_safra_situacoes(r.ano, r.semestre);
    v_aca := public.carteira_em_aberto_por_status_academico(r.ano, r.semestre);
    v_pen := public.carteira_pendencias_por_motivo(r.ano, r.semestre);

    -- TRAVA: a composicao academica tem de fechar com o balde em_aberto das seis
    -- linhas do MESMO recorte, nos tres numeros. Divergencia financeira dentro
    -- da tela nao pode ser gravada.
    if (v_aca->'total'->>'valor')::numeric
         is distinct from coalesce((v_sit->'situacoes'->'em_aberto'->>'valor')::numeric, 0)
       or (v_aca->'total'->>'alunos')::integer
         is distinct from coalesce((v_sit->'situacoes'->'em_aberto'->>'alunos')::integer, 0)
       or (v_aca->'total'->>'titulos')::integer
         is distinct from coalesce((v_sit->'situacoes'->'em_aberto'->>'titulos')::integer, 0) then
      raise exception
        'recorte %: composicao academica (% / % al / % tit) nao fecha com a linha Em aberto (% / % al / % tit); fotografia nao gravada',
        r.recorte,
        (v_aca->'total'->>'valor'), (v_aca->'total'->>'alunos'), (v_aca->'total'->>'titulos'),
        (v_sit->'situacoes'->'em_aberto'->>'valor'), (v_sit->'situacoes'->'em_aberto'->>'alunos'),
        (v_sit->'situacoes'->'em_aberto'->>'titulos');
    end if;

    -- Recorte que devolve carteira vazia seria fotografia de tela em branco.
    if coalesce((v_sit->'situacoes'->'entrou'->>'valor')::numeric, 0) <= 0 then
      raise exception 'recorte % devolveu universo vazio; fotografia nao gravada', r.recorte;
    end if;

    insert into public.carteira_efetividade_snapshot
      (recorte, bloco, ano, semestre, payload, gerado_em, duracao_ms)
    select r.recorte, b.bloco, r.ano, r.semestre, b.payload, now(),
           round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int
      from (values ('situacoes', v_sit), ('academico', v_aca), ('pendencias', v_pen)) b(bloco, payload)
    on conflict (recorte, bloco) do update
      set ano = excluded.ano, semestre = excluded.semestre, payload = excluded.payload,
          gerado_em = excluded.gerado_em, duracao_ms = excluded.duracao_ms,
          -- fotografia nova nasce em dia: a marca que pediu esta reconstrucao
          -- morre aqui, nao antes -- se o recalculo abortar, a marca fica.
          invalidada_em = null, invalidada_por = null;

    v_feitos := v_feitos || jsonb_build_object(
      'recorte', r.recorte,
      'em_aberto', (v_sit->'situacoes'->'em_aberto'->>'valor')::numeric,
      'composicao_fecha', true,
      'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int);
  end loop;

  return jsonb_build_object('gerado_em', now(), 'recortes', v_feitos);
end;
$function$;

revoke all on function public.carteira_efetividade_snapshot_recalcular(text) from public, anon;
grant execute on function public.carteira_efetividade_snapshot_recalcular(text) to authenticated, service_role;

-- ----------------------------------------------------------- 3. leitura (tela)
-- Um bloco de um recorte. A tela faz tres leituras e cada uma e um index scan de
-- UMA linha -- nada do universo e recomputado.
create or replace function public.carteira_efetividade_ler(
  p_bloco    text,
  p_ano      text,
  p_semestre text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_recorte text;
  v_out     jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if p_bloco is null or p_bloco not in ('situacoes', 'academico', 'pendencias') then
    raise exception 'Bloco desconhecido: %. Use situacoes, academico ou pendencias.', p_bloco
      using errcode = '22023';
  end if;

  v_recorte := case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre, '1') else p_ano end;

  -- `desatualizada` e `invalidada_em` vao JUNTO do payload: a tela nao pode
  -- apresentar fotografia antiga como se fosse dado ao vivo, e para dizer
  -- "Atualizacao pendente" ela precisa saber disso na mesma leitura.
  select s.payload || jsonb_build_object('snapshot', jsonb_build_object(
           'gerado_em', s.gerado_em, 'duracao_ms', s.duracao_ms, 'bloco', s.bloco,
           'desatualizada', (s.invalidada_em is not null),
           'invalidada_em', s.invalidada_em,
           'invalidada_por', s.invalidada_por))
    into v_out
    from public.carteira_efetividade_snapshot s
   where s.recorte = v_recorte and s.bloco = p_bloco;

  -- Sem fotografia a tela precisa DIZER isso. Lista vazia e indistinguivel de
  -- "nao ha nada" e foi exatamente assim que um bloco sumiu em 06/10/2026.
  return coalesce(v_out, jsonb_build_object(
    'sem_snapshot', true, 'recorte', v_recorte, 'bloco', p_bloco));
end;
$function$;

revoke all on function public.carteira_efetividade_ler(text, text, text) from public, anon;
grant execute on function public.carteira_efetividade_ler(text, text, text) to authenticated, service_role;

-- --------------------------------------------------- 4. primeira fotografia
select public.carteira_efetividade_snapshot_recalcular();

-- ------------------------------------------------------------- 5. as rotinas
-- Nao nascem aqui. A politica de atualizacao -- gatilho que marca, cron de 5
-- minutos que atende e rede de seguranca horaria as :40 -- e toda da migration
-- 20261007230000, para este arquivo ficar so com a camada em si.
