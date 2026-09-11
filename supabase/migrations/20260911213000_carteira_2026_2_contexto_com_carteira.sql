-- O contexto de 2026/2 passa a dizer TAMBÉM o tamanho da carteira recebida.
--
-- POR QUE: sem isso, R$ 94.714,96 fica sem referência e vira leitura de
-- desempenho fraco. Com a carteira ao lado (R$ 5.144.230,89 em 2.535 títulos,
-- 1.921 CPFs, 15 remessas de 06/07 a 09/09), fica evidente que o negociado é
-- uma parte da carteira recebida até agora — e não que o resto seja
-- inadimplência: o semestre está vigente e as remessas são recentes.
--
-- NENHUM cálculo muda: são contagens da mesma janela que a função já lia, e a
-- razão entre as duas (1,84%) NÃO é devolvida — de propósito, para não virar
-- indicador de performance de um semestre em formação.
begin;

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
    select t.created_at, t.importacao_id, t.valor_original,
           lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') cpf
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
    'carteira_valor',   round(coalesce(sum(valor_original),0),2),
    'carteira_titulos', count(*),
    'carteira_cpfs',    count(distinct cpf),
    'atualizado_em',    now()
  ) into v from t;
  return v;
end; $$;
revoke all on function public.carteira_2026_2_contexto() from public, anon;
grant execute on function public.carteira_2026_2_contexto() to authenticated;

do $$
declare v jsonb;
begin
  v := public.carteira_2026_2_contexto();
  if coalesce((v->>'carteira_titulos')::int,0) = 0 then raise exception 'contexto sem carteira'; end if;
end $$;

commit;
