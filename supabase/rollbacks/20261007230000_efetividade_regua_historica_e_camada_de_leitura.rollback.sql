-- ROLLBACK de 20261007230000_efetividade_regua_historica_e_camada_de_leitura.sql
--
-- O que a migration fez: trocou o universo de 2024/2025 em
-- `carteira_em_aberto_por_status_academico` pela regua historica oficial, criou
-- duas tabelas de fotografia, tres funcoes (recalcular / ler / itens_ler) e uma
-- rotina horaria.
--
-- NAO HA DADO DE NEGOCIO A RESTAURAR. As duas tabelas sao fotografia derivada:
-- tudo nelas e reconstruivel a partir das funcoes vivas, que nao foram
-- alteradas. Derruba-las nao perde informacao nenhuma.
--
-- O QUE NAO FOI TOCADO, e portanto nao precisa de reversao:
--   carteira_2026_1_classificar, carteira_safra_situacoes,
--   carteira_saldo_historico_* , carteira_academico_perfil_*,
--   carteira_2026_2_*, casos_pendentes_contar, o fluxo EM_CONFIRMACAO e as
--   RPCs da Conferencia Prime.
--
-- EFEITO NA TELA depois do rollback: a Efetividade volta a depender das
-- consultas vivas. ATENCAO -- isto reintroduz o timeout medido em 07/10/2026:
-- `carteira_safra_situacoes('2026','1')` estoura o teto de 8s do papel
-- `authenticated`. O rollback devolve o estado anterior, que ja era o estado
-- quebrado; ele nao e uma correcao.
--
-- A ordem importa: a rotina primeiro, depois as funcoes, depois as tabelas.

select cron.unschedule('carteira_efetividade_hora')
 where exists (select 1 from cron.job where jobname = 'carteira_efetividade_hora');

drop function if exists public.carteira_pendencias_itens_ler(text, text, text, integer, integer);
drop function if exists public.carteira_efetividade_ler(text, text, text);
drop function if exists public.carteira_efetividade_recalcular(text);

drop table if exists public.carteira_pendencias_item_snapshot;
drop table if exists public.carteira_efetividade_snapshot;

-- ---------------------------------------------------------------------------
-- A COMPOSICAO VOLTA A REGUA DAS SEIS LINHAS EM 2024/2025
--
-- Este corpo e o da migration 20261007193000, byte a byte no que importa: o
-- universo de 2024/2025 volta a ser o balde "em aberto" das seis linhas
-- (R$ 4.995.079,31 em 2024, contra R$ 3.674.539,61 da regua historica). Ou
-- seja: o rollback reintroduz a divergencia de regua que o ajuste veio
-- resolver. Esta aqui porque rollback tem de devolver o estado anterior, nao
-- um estado melhor.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_em_aberto_por_status_academico(
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
  v_out jsonb;
  v_ano text := nullif(btrim(coalesce(p_ano, '')), '');
  v_sem text := nullif(btrim(coalesce(p_semestre, '')), '');
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if v_ano is null then
    raise exception 'Informe o ano.' using errcode = '22023';
  end if;

  if v_ano = '2026' and v_sem = '2' then
    raise exception '2026/2 nao tem fonte academica equivalente; status academico nao se aplica a esta safra.'
      using errcode = '22023';
  end if;

  if v_ano = '2026' and v_sem = '1' then
    with c as (select * from public.carteira_2026_1_classificar()),
    abertos as (
      select c.aluno_id, c.titulo_id, (c.inadimplencia + c.em_validacao) as valor
        from c where c.inadimplencia + c.em_validacao > 0
    ),
    porstatus as (
      select coalesce(nullif(btrim(al.situacao_academica), ''), '(sem situação importada)') as status,
             a.aluno_id, a.titulo_id, a.valor
        from abertos a left join public.alunos al on al.id = a.aluno_id
    ),
    linhas as (
      select status, count(distinct aluno_id) as alunos,
             count(distinct titulo_id) as titulos, round(sum(valor), 2) as valor
        from porstatus group by status
    ),
    tot as (
      select count(distinct aluno_id) as alunos, count(distinct titulo_id) as titulos,
             round(sum(valor), 2) as valor from abertos
    ),
    fonte as (
      select max(al.academico_atualizado_em) as atualizado_em
        from (select distinct aluno_id from abertos) u
        join public.alunos al on al.id = u.aluno_id
    )
    select jsonb_build_object(
      'recorte', '2026/1', 'natureza', 'CARTEIRA_CONSOLIDADA',
      'fonte', 'carteira_2026_1_classificar() ao vivo',
      'universo_em_aberto', 'inadimplencia + em_validacao',
      'gerado_em', now(),
      'total', (select jsonb_build_object('alunos', alunos, 'titulos', titulos,
                                          'valor', coalesce(valor, 0)) from tot),
      'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                    'status', status, 'alunos', alunos, 'titulos', titulos, 'valor', valor)
                    order by valor desc, status), '[]'::jsonb) from linhas),
      'conferencia', (select jsonb_build_object(
                    'total_valor', coalesce(t.valor, 0),
                    'soma_das_linhas', coalesce((select round(sum(valor), 2) from linhas), 0),
                    'diferenca', round(coalesce(t.valor, 0)
                                       - coalesce((select sum(valor) from linhas), 0), 2),
                    'fecha', round(coalesce(t.valor, 0)
                                   - coalesce((select sum(valor) from linhas), 0), 2) = 0,
                    'titulos_total', t.titulos,
                    'titulos_soma', coalesce((select sum(titulos) from linhas), 0))
                    from tot t),
      'fonte_academica', (select jsonb_build_object(
                    'importacao_atualizada_em', atualizado_em) from fonte)
    ) into v_out;
    return v_out;
  end if;

  if v_ano not in ('2024', '2025') then
    raise exception 'Safra sem regua definida: %. Use 2024, 2025 ou 2026/1.', v_ano
      using errcode = '22023';
  end if;

  with ts as (
    select regexp_replace(coalesce(boleto, ''), '\D', '', 'g') b, max(semestre) semestre
      from public.prime_titulo_semestre group by 1
  ),
  pag as (
    select regexp_replace(titulo_numero, '\D', '', 'g') b, sum(valor_pago) pago
      from public.pagamentos where coalesce(titulo_numero, '') <> '' group by 1
  ),
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER', 'VENCIDA')), 0) abertas
      from public.parcelas group by 1
  ),
  ac as (
    select a.id, a.status,
           case when coalesce(p.pagas, 0) + coalesce(p.abertas, 0) > 0
                then coalesce(p.pagas, 0) / (coalesce(p.pagas, 0) + coalesce(p.abertas, 0))
                when a.status = 'QUITADO' then 1 else 0 end ratio
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  t as (
    select t.id as titulo_id, t.aluno_id, t.valor_original vo,
           upper(coalesce(t.situacao, '')) sit,
           (t.acordo_id is not null and ac.status = 'ATIVO') acordo_ativo,
           (t.acordo_id is not null) tem_acordo,
           coalesce(ac.ratio, 0) ratio,
           coalesce(pg.pago, 0) pago_direto,
           (t.origem_liquidacao is not null) liq_prime
      from public.acordos_titulos t
      left join ts on ts.b = regexp_replace(coalesce(t.documento, ''), '\D', '', 'g')
      left join ac on ac.id = t.acordo_id
      left join pag pg on pg.b = regexp_replace(coalesce(t.documento, ''), '\D', '', 'g')
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and (t.tipo_boleto ilike 'Cursos de Gradua%' or t.tipo_boleto ilike 'Cursos de P%s Gradua%')
       and left(ts.semestre, 4) = v_ano
  ),
  m as (
    select titulo_id, aluno_id, vo, acordo_ativo,
           (sit = 'CANCELADA') as eh_cancelado, (sit = 'EM_CONFIRMACAO') as eh_confirm,
           (sit = 'PAGO' and not tem_acordo and not liq_prime and pago_direto = 0) as pago_sem_lastro,
           least(case when tem_acordo then vo * ratio
                      when liq_prime or pago_direto > 0 then least(pago_direto, vo)
                      else 0 end, vo) as recuperado
      from t
  ),
  n as (
    select *, (eh_cancelado or eh_confirm or pago_sem_lastro) as fora,
              greatest(vo - recuperado, 0) as resto from m
  ),
  abertos as (
    select aluno_id, titulo_id, resto as valor from n
     where not fora and not acordo_ativo and resto > 0
  ),
  porstatus as (
    select coalesce(nullif(btrim(al.situacao_academica), ''), '(sem situação importada)') as status,
           a.aluno_id, a.titulo_id, a.valor
      from abertos a left join public.alunos al on al.id = a.aluno_id
  ),
  linhas as (
    select status, count(distinct aluno_id) as alunos,
           count(distinct titulo_id) as titulos, round(sum(valor), 2) as valor
      from porstatus group by status
  ),
  tot as (
    select count(distinct aluno_id) as alunos, count(distinct titulo_id) as titulos,
           round(sum(valor), 2) as valor from abertos
  ),
  fonte as (
    select max(al.academico_atualizado_em) as atualizado_em
      from (select distinct aluno_id from abertos) u
      join public.alunos al on al.id = u.aluno_id
  )
  select jsonb_build_object(
    'recorte', v_ano, 'natureza', 'COBERTURA_HISTORICA',
    'fonte', 'acordos_titulos + serie da Prime, ao vivo',
    'universo_em_aberto', 'saldo sem acordo ativo (balde "em aberto" das seis linhas)',
    'gerado_em', now(),
    'total', (select jsonb_build_object('alunos', alunos, 'titulos', titulos,
                                        'valor', coalesce(valor, 0)) from tot),
    'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                  'status', status, 'alunos', alunos, 'titulos', titulos, 'valor', valor)
                  order by valor desc, status), '[]'::jsonb) from linhas),
    'conferencia', (select jsonb_build_object(
                  'total_valor', coalesce(t.valor, 0),
                  'soma_das_linhas', coalesce((select round(sum(valor), 2) from linhas), 0),
                  'diferenca', round(coalesce(t.valor, 0)
                                     - coalesce((select sum(valor) from linhas), 0), 2),
                  'fecha', round(coalesce(t.valor, 0)
                                 - coalesce((select sum(valor) from linhas), 0), 2) = 0,
                  'titulos_total', t.titulos,
                  'titulos_soma', coalesce((select sum(titulos) from linhas), 0))
                  from tot t),
    'fonte_academica', (select jsonb_build_object(
                  'importacao_atualizada_em', atualizado_em) from fonte)
  ) into v_out;

  return v_out;
end;
$function$;
