-- "Status academico por safra" passa a responder TAMBEM em dinheiro: por status,
-- quantos alunos inadimplentes, quantos titulos em aberto e quanto saldo.
--
-- POR QUE UM OBJETO NOVO. O snapshot que a tela ja le
-- (`carteira_academico_perfil_snapshot`) guarda SO a contagem de alunos por
-- situacao. Ele nao tem titulo nem saldo, e nao da para derivar: a contagem
-- agregada nao sabe a qual titulo cada aluno corresponde. Sem este objeto a
-- pergunta "qual o saldo em aberto dos Formados de 2025" nao tem resposta.
--
-- POR QUE SNAPSHOT E NAO LEITURA AO VIVO. Medido em 07/10/2026: o cruzamento de
-- 2024/2025 reconstroi o universo no nivel de TITULO, o que e mais caro do que a
-- reconstrucao por aluno que ja estourava o statement_timeout de 8s do papel
-- `authenticated` (foi essa a causa do bloco "Alunos por status" sumir, e por
-- isso ele virou snapshot em 06/10). Mesmo padrao, mesma razao.
--
-- NENHUMA REGRA FINANCEIRA NOVA. `carteira_academico_saldo_detalhe` e a versao
-- POR TITULO do universo que `carteira_academico_universo` ja devolve por aluno
-- -- mesmos filtros, mesma ordem, mesmas exclusoes, copiados de proposito em vez
-- de parafraseados. O recalculo ASSERTA a equivalencia: se o detalhe por titulo
-- nao devolver exatamente o mesmo numero de alunos que o universo oficial, ele
-- aborta em vez de gravar.
--
-- CONFERIDO EM PRODUCAO em 07/10/2026: alunos, titulos e saldo das tres safras
-- batem exatamente com `carteira_saldo_historico_snapshot` (2024 e 2025) e com
-- `carteira_2026_1_classificar` (2026/1) -- seis de seis, sem aproximacao. As
-- quantidades medidas ficam no PR, nao em arquivo versionado.
--
-- NENHUM NUMERO E FIXADO, aqui nem no front, de proposito: 2026/1 e calculado da
-- base viva e ja se moveu entre duas medicoes da mesma manha. O que o codigo
-- garante e o FECHAMENTO -- a soma das linhas por status bate com o total da
-- safra na mesma fotografia -- nunca um numero decorado.
--
-- NENHUM AGRUPAMENTO. A linha e o valor cru de `alunos.situacao_academica`, e
-- `(sem situacao importada)` e uma linha real como qualquer outra, nao um resto.
-- "Matriculado Curso Normal" e "Aguardando Matricula" ficam SEPARADOS.
--
-- NAO SOMAR AS TRES SAFRAS por aluno: medido em 07/10/2026, ha CPF em mais de uma
-- safra nos tres pares, e a uniao real e menor que a soma das tres. O payload nao
-- traz total das tres, justamente para a tela nao ter o que somar.
--
-- ESCOPO: 2024, 2025 e 2026/1. 2026/2 NAO entra. As seis linhas financeiras vem
-- de `carteira_safra_situacoes` e nao foram tocadas.

-- ------------------------------------- 1. o universo por TITULO (so leitura)
create or replace function public.carteira_academico_saldo_detalhe(p_ano text, p_semestre text default null)
returns table(cpf text, aluno_id uuid, titulos integer, saldo numeric)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if p_ano = '2026' and coalesce(p_semestre,'1') = '1' then
    -- 2026/1: a propria classificacao da safra. O elegivel e o MESMO de
    -- `carteira_academico_universo` -- group by cpf, having saldo > 0,01 -- e o
    -- `(array_agg(aluno_id))[1]` e o mesmo dedup, repetido aqui para os dois
    -- contarem igual. `titulos` conta a linha que tem saldo; `saldo` soma o CPF
    -- inteiro, que e o que fecha com o total da safra.
    return query
      with cls as materialized (
        select c.cpf, c.aluno_id, c.inadimplencia, c.em_validacao
          from public.carteira_2026_1_classificar() c
      )
      select e.cpf, e.aluno_id,
             coalesce(t.titulos, 0)::integer,
             e.saldo
        from (select c.cpf, (array_agg(c.aluno_id))[1] aluno_id,
                     sum(c.inadimplencia + c.em_validacao) saldo
                from cls c group by c.cpf
               having sum(c.inadimplencia + c.em_validacao) > 0.01) e
        left join (select c.cpf, count(*)::integer titulos from cls c
                    where c.inadimplencia + c.em_validacao > 0.01 group by c.cpf) t
               on t.cpf = e.cpf;

  elsif p_ano in ('2024','2025') then
    -- 2024/2025: a MESMA reconstrucao de `carteira_academico_universo`, parada um
    -- passo antes do `group by cpf` para o titulo sobreviver. Qualquer mudanca de
    -- criterio tem de ser feita NAS DUAS -- a assercao do recalculo acusa se
    -- divergirem.
    return query
      with pag_titulo as materialized (
        select distinct titulo_numero b from public.pagamentos where coalesce(titulo_numero,'') <> ''
      ),
      m166 as materialized (
        select distinct lpad(regexp_replace(prime_portador_membro.cpf, '\D', '', 'g'), 11, '0') cpf
          from public.prime_portador_membro where portador = 166
      ),
      acordo_ativo as materialized (
        select distinct a.aluno_id from public.acordos a where a.status = 'ATIVO' and a.aluno_id is not null
      ),
      conf as materialized (
        select distinct s.aluno_id from public.solicitacoes_confirmacao_pagamento s
         where s.status = 'AGUARDANDO_CONFIRMACAO'
      ),
      caso_fora as materialized (
        select distinct k.aluno_id from public.casos k
         where public.normalizar_status_acionamento(
                 coalesce(k.status_atual, k.status_acionamento, k.status_jornada))
               = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'])
      ),
      pago_julho as materialized (
        select p.aluno_id, sum(p.valor_pago) pago from public.pagamentos p
         where p.data_pagamento >= date '2026-07-01' and p.aluno_id is not null group by 1
      ),
      t as materialized (
        select tt.id, tt.aluno_id,
               lpad(regexp_replace(coalesce(nullif(tt.cpf,''), al.cpf, ''), '\D', '', 'g'), 11, '0') cpf,
               coalesce(tt.valor_cobranca_ajustado, tt.saldo_corrigido, tt.valor_em_aberto, tt.valor_original, 0) saldo,
               tt.situacao, tt.status, tt.vencimento, tt.origem_liquidacao, tt.acordo_id,
               ts.semestre, left(ts.semestre, 4) ano,
               case when ex.boleto is null then ts.carrier_id
                    when ts.boleto is null or ex.coletado_em >= ts.coletado_em then ex.portador
                    else ts.carrier_id end portador,
               case when ex.boleto is null then ts.liquidado_em
                    when ts.boleto is null or ex.coletado_em >= ts.coletado_em then ex.liquidado_em
                    else ts.liquidado_em end liq,
               (tt.acordo_id is not null
                or exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = tt.id)) negociado,
               exists (select 1 from public.parcelas p where p.boleto = tt.documento) eh_boleto_de_parcela,
               (pg.b is not null) tem_pagamento_no_titulo
          from public.acordos_titulos tt
          left join public.alunos al on al.id = tt.aluno_id
          left join lateral (select s.semestre, s.carrier_id, s.liquidado_em, s.coletado_em, s.boleto
                               from public.prime_titulo_semestre s where s.boleto = tt.documento limit 1) ts on true
          left join lateral (select e.portador, e.liquidado_em, e.coletado_em, e.boleto
                               from public.prime_extrato e where e.boleto = tt.documento limit 1) ex on true
          left join pag_titulo pg on pg.b = tt.documento
         where tt.situacao <> 'DUPLICADA'
           and coalesce(tt.tipo_boleto,'') <> 'Acordo'
           and (tt.tipo_boleto ilike 'Cursos de Gradua%' or tt.tipo_boleto ilike 'Cursos de P%s Gradua%')
      ),
      cand as materialized (
        select *, sum(saldo) over (partition by t.aluno_id) devido_total
          from t
         where upper(coalesce(situacao,'')) = 'ABERTO'
           and lower(coalesce(status,'')) = 'em_aberto'
           and not negociado and acordo_id is null and not eh_boleto_de_parcela
           and not tem_pagamento_no_titulo and origem_liquidacao is null and saldo > 0
           and portador = 195
           and not coalesce(liq > vencimento + 30, false)
           and (semestre in ('2024/1','2024/2','2025/1','2025/2') or semestre is null)
      )
      select c.cpf, (array_agg(c.aluno_id))[1], count(*)::integer, sum(c.saldo)
        from cand c
        left join m166 m on m.cpf = c.cpf
        left join acordo_ativo aa on aa.aluno_id = c.aluno_id
        left join conf cf on cf.aluno_id = c.aluno_id::text
        left join caso_fora cx on cx.aluno_id = c.aluno_id
        left join pago_julho pj on pj.aluno_id = c.aluno_id
       where not ((m.cpf is not null and aa.aluno_id is null)
               or cf.aluno_id is not null or cx.aluno_id is not null
               or coalesce(pj.pago,0) >= c.devido_total)
         and c.ano = p_ano
       group by c.cpf;

  else
    -- Recorte que nao existe devolve VAZIO, nunca a carteira inteira.
    return;
  end if;
end;
$function$;

revoke all on function public.carteira_academico_saldo_detalhe(text, text) from public, anon;
grant execute on function public.carteira_academico_saldo_detalhe(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------- 2. a tabela
create table if not exists public.carteira_academico_saldo_snapshot (
  recorte            text        primary key,   -- '2024' | '2025' | '2026/1'
  ano                text        not null,
  semestre           text,
  payload            jsonb       not null,
  total_alunos       integer     not null,
  total_titulos      integer     not null,
  total_saldo        numeric     not null,
  linhas             integer     not null,
  -- assinatura da FONTE ACADEMICA: max(alunos.academico_atualizado_em) do
  -- recorte. E por ela que a rotina sabe que a importacao mexeu.
  fonte_academica_em timestamptz,
  gerado_em          timestamptz not null default now(),
  duracao_ms         integer
);

comment on table public.carteira_academico_saldo_snapshot is
  'Fotografia de alunos/titulos/saldo em aberto por situacao academica, por recorte. A tela le por carteira_academico_saldo_ler().';

-- Tabela nova herda privilegios amplos do schema public -- inclusive TRUNCATE
-- para authenticated, e RLS nao cobre TRUNCATE. Fecha explicitamente.
alter table public.carteira_academico_saldo_snapshot enable row level security;
revoke all on table public.carteira_academico_saldo_snapshot from public, anon, authenticated;
grant select, insert, update, delete on table public.carteira_academico_saldo_snapshot to service_role;

-- ------------------------------------------------------- 3. recalculo (escrita)
create or replace function public.carteira_academico_saldo_recalcular(p_recorte text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  r             record;
  v_t0          timestamptz;
  v_alunos      integer;
  v_titulos     integer;
  v_saldo       numeric;
  v_universo    integer;
  v_linhas      jsonb;
  v_n_linhas    integer;
  v_fonte       timestamptz;
  v_conf        jsonb;
  v_feitos      jsonb := '[]'::jsonb;
begin
  -- Escrita: so service_role (rotina) ou a gestao pela tela.
  if not (coalesce(auth.role(),'') = 'service_role'
          or auth.jwt() is null
          or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  for r in
    select * from (values ('2024','2024',null::text),
                          ('2025','2025',null::text),
                          ('2026/1','2026','1')) v(recorte, ano, semestre)
     where p_recorte is null or v.recorte = p_recorte
  loop
    v_t0 := clock_timestamp();

    create temporary table _saldo_det on commit drop as
      select d.cpf, d.aluno_id, d.titulos, d.saldo,
             coalesce(al.situacao_academica, '(sem situação importada)') situacao,
             al.academico_atualizado_em
        from public.carteira_academico_saldo_detalhe(r.ano, r.semestre) d
        left join public.alunos al on al.id = d.aluno_id;

    select count(*), sum(titulos), sum(saldo), max(academico_atualizado_em)
      into v_alunos, v_titulos, v_saldo, v_fonte
      from _saldo_det;

    -- ASSERCAO 1: o universo por TITULO tem de conter exatamente os mesmos
    -- alunos que o universo oficial por aluno. Se divergir, um dos dois mudou de
    -- criterio e a quebra por status estaria descrevendo outra carteira.
    select count(*) into v_universo
      from public.carteira_academico_universo(r.ano, r.semestre);

    if v_alunos is distinct from v_universo then
      raise exception 'recorte %: detalhe por titulo tem % alunos e carteira_academico_universo tem %; snapshot nao gravado',
        r.recorte, v_alunos, v_universo;
    end if;

    if coalesce(v_alunos, 0) = 0 then
      raise exception 'recorte % devolveu zero alunos; snapshot nao gravado', r.recorte;
    end if;

    -- As LINHAS, uma por valor cru de situacao_academica. Sem agrupamento, sem
    -- equivalencia, sem "Outros". `pct` e sobre o saldo DA SAFRA.
    select jsonb_agg(x order by x.saldo desc, x.situacao), count(*)
      into v_linhas, v_n_linhas
      from (select situacao,
                   count(*)::integer alunos,
                   sum(titulos)::integer titulos,
                   round(sum(saldo), 2) saldo,
                   round(100.0 * sum(saldo) / nullif(v_saldo, 0), 2) pct
              from _saldo_det group by situacao) x;

    -- ASSERCAO 2: as linhas tem de FECHAR com o total da safra. E este o
    -- compromisso do card -- nao um numero decorado, mas o fechamento.
    if (select sum((l->>'alunos')::integer) from jsonb_array_elements(v_linhas) l) is distinct from v_alunos
       or (select sum((l->>'titulos')::integer) from jsonb_array_elements(v_linhas) l) is distinct from v_titulos then
      raise exception 'recorte %: a quebra por status nao fecha com o total; snapshot nao gravado', r.recorte;
    end if;

    -- CONFERENCIA com a fonte oficial da safra, guardada no payload em vez de
    -- abortar: os dois snapshots sao tirados em instantes diferentes, e 2026/1 e
    -- calculado da base viva. A tela pode mostrar se fecha; ela nao pode mentir
    -- que fecha.
    if r.ano in ('2024','2025') then
      select jsonb_build_object(
               'fonte', 'carteira_saldo_historico_snapshot',
               'alunos', (a->'aberto'->>'alunos')::integer,
               'titulos', (a->'aberto'->>'mensalidades')::integer,
               'saldo', round((a->'aberto'->>'valor')::numeric, 2),
               'gerado_em', s.gerado_em)
        into v_conf
        from public.carteira_saldo_historico_snapshot s
        cross join lateral jsonb_array_elements(s.payload->'anos') a
       where a->>'ano' = r.ano
       limit 1;
    else
      v_conf := null;
    end if;

    insert into public.carteira_academico_saldo_snapshot
      (recorte, ano, semestre, payload, total_alunos, total_titulos, total_saldo,
       linhas, fonte_academica_em, gerado_em, duracao_ms)
    values
      (r.recorte, r.ano, r.semestre,
       jsonb_build_object(
         'recorte', r.recorte,
         'total', jsonb_build_object('alunos', v_alunos, 'titulos', v_titulos,
                                     'saldo', round(v_saldo, 2)),
         'linhas', coalesce(v_linhas, '[]'::jsonb),
         'fonte_academica', jsonb_build_object(
            'fonte', 'Relatório de inadimplência (importação)',
            'atualizado_em', v_fonte),
         'conferencia', v_conf),
       v_alunos, v_titulos, round(v_saldo, 2), coalesce(v_n_linhas, 0), v_fonte, now(),
       round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int)
    on conflict (recorte) do update
      set ano = excluded.ano, semestre = excluded.semestre, payload = excluded.payload,
          total_alunos = excluded.total_alunos, total_titulos = excluded.total_titulos,
          total_saldo = excluded.total_saldo, linhas = excluded.linhas,
          fonte_academica_em = excluded.fonte_academica_em,
          gerado_em = excluded.gerado_em, duracao_ms = excluded.duracao_ms;

    v_feitos := v_feitos || jsonb_build_object(
      'recorte', r.recorte, 'alunos', v_alunos, 'titulos', v_titulos,
      'saldo', round(v_saldo, 2), 'linhas', coalesce(v_n_linhas, 0),
      'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int);

    drop table _saldo_det;
  end loop;

  return jsonb_build_object('gerado_em', now(), 'recortes', v_feitos);
end;
$function$;

revoke all on function public.carteira_academico_saldo_recalcular(text) from public, anon;
grant execute on function public.carteira_academico_saldo_recalcular(text) to authenticated, service_role;

-- ----------------------------------------------------------- 4. leitura (tela)
-- UMA chamada devolve as tres safras. De proposito nao existe total das tres:
-- ha CPF em mais de uma safra, e um total somado seria contagem dupla.
create or replace function public.carteira_academico_saldo_ler()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'lido_em', now(),
           'safras', coalesce(jsonb_agg(
             s.payload || jsonb_build_object('snapshot', jsonb_build_object(
               'gerado_em', s.gerado_em, 'duracao_ms', s.duracao_ms))
             order by s.recorte), '[]'::jsonb))
    into v_out
    from public.carteira_academico_saldo_snapshot s;

  return v_out;
end;
$function$;

revoke all on function public.carteira_academico_saldo_ler() from public, anon;
grant execute on function public.carteira_academico_saldo_ler() to authenticated, service_role;

-- --------------------------------------------------- 5. primeira fotografia
select public.carteira_academico_saldo_recalcular();

-- ------------------------------------------------------------- 6. a rotina
-- Diaria, 06:35 -- depois de `carteira_academico_perfil_sincronizar` (06:25),
-- para as duas fotografias da mesma tela nao sairem de instantes trocados.
select cron.schedule('carteira_academico_saldo_recalcular', '35 6 * * *',
                     $cron$select public.carteira_academico_saldo_recalcular();$cron$)
 where not exists (select 1 from cron.job where jobname = 'carteira_academico_saldo_recalcular');
