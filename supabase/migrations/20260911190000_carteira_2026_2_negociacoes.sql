-- ============================================================================
-- NEGOCIAÇÕES 2026/2 — semestre vigente (complemento do relatório 2026/1)
-- ----------------------------------------------------------------------------
-- 2026/2 está em andamento: NÃO se calcula inadimplência, não se trata a
-- carteira inteira como não convertida e não se compara com 100% do semestre —
-- há título a vencer, e a carteira ainda está em formação conforme as remessas
-- entram. A pergunta aqui é outra:
--
--   Quanto do semestre vigente já precisou ser negociado, e quanto dessas
--   negociações já foi recebido?
--
-- REGRAS (as mesmas de 2026/1, sem reabrir nada de lá):
--  * SAFRA pela SÉRIE DO PRIME; fallback por vencimento (jul–dez/2026) só onde
--    o Prime não tem série, marcado em `fonte_semestre` para auditoria. A série
--    é o que separa de verdade: título de série 2026/2 vence desde 05/05/2026
--    (matrícula antecipada) e pelo vencimento cairia em 2026/1.
--  * VALOR pelo ORIGINAL do título. Juros, multa e honorário não aumentam a
--    carteira negociada.
--  * ACORDO MULTI-SAFRA entra aqui só com a parte 2026/2 — o título é a
--    unidade, nunca a parcela inteira do acordo. Sem dupla contagem com 2026/1.
--  * RECEBIDO = valor original × (parcelas pagas ÷ total do acordo), a mesma
--    régua de 2026/1. Negociado e recebido são indicadores separados.
--
-- EXCLUSÃO QUE MUDA O NÚMERO EM 4x (medido 11/09/2026): título com
-- `tipo_boleto = 'Acordo'` é PARCELA DE ACORDO RENEGOCIADA que virou título
-- (`documento = '0' || boleto da parcela`), não mensalidade do semestre. São
-- 266 títulos / R$ 292.946,79 que o fallback de vencimento traria para cá —
-- boa parte com origem em 2026/1, ou seja, dupla contagem com o relatório já
-- publicado. Ficam de fora.
--
-- Medido em PROD 11/09/2026: 61 títulos, 56 CPFs, 56 acordos,
-- R$ 94.714,96 negociados, R$ 71.066,83 recebidos, R$ 23.648,13 de saldo.
-- Remessas de 2026/2: 15, de 06/07 a 09/09/2026.
--
-- Aditivo: não toca em nada de 2026/1 (base congelada, snapshot, RPCs, tela).
-- Reversível: drop das três funções.
-- ============================================================================
begin;

create or replace function public.carteira_2026_2_negociacoes()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  drop table if exists _n22;
  create temp table _n22 on commit drop as
  with serie as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(semestre) semestre
      from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
  ),
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas,
           count(*) filter (where status = 'VENCIDA' and vencimento >= current_date - 30) venc_ate30,
           count(*) filter (where status = 'VENCIDA' and vencimento <  current_date - 30) venc_mais30
      from public.parcelas group by 1
  ),
  acordo as (
    select a.id, a.numero_ulbra, a.status,
           case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                when a.status = 'QUITADO' then 1 else 0 end ratio,
           case when a.status = 'CANCELADO' then 'Acordo cancelado'
                when a.status = 'QUITADO'   then 'Quitado'
                when coalesce(p.venc_mais30,0) > 0 then 'Acordo quebrado'
                when coalesce(p.venc_ate30,0)  > 0 then 'Em atraso'
                else 'Regular' end estado
      from public.acordos a left join parc p on p.acordo_id = a.id
  )
  select t.id titulo_id, t.aluno_id,
         lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') cpf,
         t.documento, t.vencimento, t.valor_original vo, t.tipo_boleto,
         ac.id acordo_id, ac.numero_ulbra, ac.estado, ac.ratio,
         round(t.valor_original * ac.ratio, 2) recebido,
         round(t.valor_original * (1 - ac.ratio), 2) saldo,
         case when s.semestre is null then 'vencimento (sem serie no Prime)' else 'serie do Prime' end fonte_semestre
    from public.acordos_titulos t
    left join public.acordo_titulo_vinculo v on v.titulo_id = t.id and v.ativo
    left join serie s on s.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
    join acordo ac on ac.id = coalesce(t.acordo_id, v.acordo_id)
   where t.situacao <> 'DUPLICADA'
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and coalesce(s.semestre,
           case when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01'
                then '2026/2' end) = '2026/2';

  select jsonb_build_object(
    'gerado_em', now(),
    'total', jsonb_build_object(
      'negociado', round(coalesce(sum(vo),0),2),
      'recebido',  round(coalesce(sum(recebido),0),2),
      'saldo',     round(coalesce(sum(saldo),0),2),
      'titulos',   count(*),
      'cpfs',      count(distinct cpf),
      'acordos',   count(distinct acordo_id),
      'titulos_por_fallback', count(*) filter (where fonte_semestre <> 'serie do Prime'),
      'valor_por_fallback',  round(coalesce(sum(vo) filter (where fonte_semestre <> 'serie do Prime'),0),2)
    ),
    'estados', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'estado', estado, 'titulos', titulos, 'cpfs', cpfs, 'acordos', acordos,
               'negociado', negociado, 'recebido', recebido, 'saldo', saldo) order by ordem), '[]'::jsonb)
        from (
          select estado, count(*) titulos, count(distinct cpf) cpfs, count(distinct acordo_id) acordos,
                 round(sum(vo),2) negociado, round(sum(recebido),2) recebido, round(sum(saldo),2) saldo,
                 case estado when 'Quitado' then 0 when 'Regular' then 1 when 'Em atraso' then 2
                             when 'Acordo quebrado' then 3 else 4 end ordem
            from _n22 group by estado
        ) x
    )
  ) into v_out from _n22;
  return v_out;
end; $$;
revoke all on function public.carteira_2026_2_negociacoes() from public, anon;
grant execute on function public.carteira_2026_2_negociacoes() to authenticated;

create or replace function public.carteira_2026_2_detalhe(
  p_estado text default null, p_limite int default 200, p_offset int default 0
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_out jsonb; v_total int; v_valor numeric;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  p_limite := least(greatest(coalesce(p_limite,200),1), 500);
  p_offset := greatest(coalesce(p_offset,0), 0);

  perform public.carteira_2026_2_negociacoes();   -- monta _n22 nesta transação

  select count(*), round(coalesce(sum(vo),0),2) into v_total, v_valor
    from _n22 where p_estado is null or estado = p_estado;

  select coalesce(jsonb_agg(jsonb_build_object(
           'aluno', coalesce(al.nome,'(sem nome)'),
           'cpf', case when length(z.cpf) = 11
                       then substr(z.cpf,1,3) || '.***.' || substr(z.cpf,7,3) || '-**' else '***' end,
           'documento', z.documento,
           'vencimento', z.vencimento,
           'valor_original', round(z.vo,2),
           'acordo', coalesce(z.numero_ulbra, '(sem numero)'),
           'estado', z.estado,
           'recebido', z.recebido,
           'saldo', z.saldo,
           'fonte_semestre', z.fonte_semestre
         ) order by z.vo desc), '[]'::jsonb)
    into v_out
    from (select * from _n22 where p_estado is null or estado = p_estado
           order by vo desc limit p_limite offset p_offset) z
    left join public.alunos al on al.id = z.aluno_id;

  return jsonb_build_object('estado', p_estado, 'total_titulos', v_total, 'total_valor', v_valor,
                            'limite', p_limite, 'offset', p_offset, 'linhas', v_out);
end; $$;
revoke all on function public.carteira_2026_2_detalhe(text,int,int) from public, anon;
grant execute on function public.carteira_2026_2_detalhe(text,int,int) to authenticated;

-- Contexto das remessas: sem isso a Diretoria lê R$ 94.714,96 como desempenho
-- fraco do semestre, quando é o volume já negociado DAS REMESSAS RECEBIDAS ATÉ
-- AGORA. Nenhum cálculo depende disto.
create or replace function public.carteira_2026_2_contexto()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  with serie as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(semestre) semestre
      from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
  ),
  t as (
    select t.created_at, t.importacao_id
      from public.acordos_titulos t
      left join serie s on s.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and coalesce(s.semestre,
             case when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01'
                  then '2026/2' end) = '2026/2'
  )
  select jsonb_build_object(
    'primeira_remessa', min(created_at)::date,
    'ultima_remessa',   max(created_at)::date,
    'remessas',         count(distinct importacao_id),
    'atualizado_em',    now()
  ) into v from t;
  return v;
end; $$;
revoke all on function public.carteira_2026_2_contexto() from public, anon;
grant execute on function public.carteira_2026_2_contexto() to authenticated;

-- Asserções: os estados somam o total, negociado = recebido + saldo, e 2026/1
-- continua fechando a base congelada (sem fixar o valor da efetividade, que
-- muda a cada recálculo legítimo da tela).
do $$
declare v jsonb; soma numeric; v1 jsonb; base numeric;
begin
  v := public.carteira_2026_2_negociacoes();
  select sum((x->>'negociado')::numeric) into soma from jsonb_array_elements(v->'estados') x;
  if abs(soma - (v->'total'->>'negociado')::numeric) > 0.01 then
    raise exception 'estados 2026/2 nao somam: % x %', soma, v->'total'->>'negociado';
  end if;
  if abs(((v->'total'->>'recebido')::numeric + (v->'total'->>'saldo')::numeric)
         - (v->'total'->>'negociado')::numeric) > 0.05 then
    raise exception 'recebido + saldo <> negociado';
  end if;
  perform public.carteira_2026_2_detalhe(null, 5, 0);
  if (public.carteira_2026_2_contexto()->>'primeira_remessa') is null then
    raise exception 'contexto sem primeira remessa';
  end if;

  v1 := public.carteira_2026_1_indicadores();
  base := (v1->'base'->>'valor')::numeric;
  if abs(((v1->'faixas'->>'efetividade')::numeric + (v1->'faixas'->>'inadimplencia')::numeric
        + (v1->'faixas'->>'em_validacao')::numeric + (v1->'faixas'->>'academico')::numeric) - base) > 0.01 then
    raise exception '2026/1 deixou de fechar a base';
  end if;
  if abs(base - 21752304.72) > 0.01 then
    raise exception 'a base congelada de 2026/1 mudou: %', base;
  end if;
end $$;

commit;
