-- ============================================================================
-- COBERTURA HISTÓRICA — 2024/1, 2024/2, 2025/1 e 2025/2
-- ----------------------------------------------------------------------------
-- POR QUE ESTA VISÃO NÃO TEM PERCENTUAL DE EFETIVIDADE (auditoria 11/09/2026):
--
-- Nenhuma fonte do CRM tem registro anterior a 01/07/2026 — acordos_titulos
-- (02/07), acordos e parcelas (03/07), pagamentos (01/07), borderôs (02/07),
-- importações de acordos (02/07). O Prime entra só como foto do estado atual
-- (coleta de 25/08 em diante).
--
-- Logo, o que existe de 2024 e 2025 NÃO é a carteira original daqueles
-- semestres: é o SALDO RESIDUAL que ainda estava aberto quando a operação
-- começou, em julho de 2026. Tudo que foi recuperado antes já tinha saído da
-- carteira antes de ela chegar aqui, e as negociações dessas safras são quase
-- todas anteriores ao CRM (2.300 dos 3.935 acordos não têm vínculo de título).
--
-- Calcular efetividade sobre esse resíduo daria 2,5% / 1,4% / 2,1% / 8,1% —
-- números que medem o tempo que a carteira está conosco, não a cobrança. Por
-- decisão da Amanda, a tela mostra só o que é comprovável e diz o que falta.
--
-- Mesma régua de safra e de valor de 2026/1: série do Prime como fonte
-- principal (fallback por vencimento), valor pelo ORIGINAL do título, título
-- `tipo_boleto = 'Acordo'` (parcela renegociada) fora, e recebido = valor
-- original × parcelas pagas ÷ total do acordo.
--
-- Medido em PROD 11/09/2026:
--   2024/1   3.318 tít / 1.123 CPFs / R$ 2.311.537,49 — negociado 37.189,36 · recebido 20.750,91 · abertos R$ 2.077.669,81
--   2024/2   5.240 tít / 1.445 CPFs / R$ 3.465.720,20 — negociado 24.023,10 · recebido 24.170,95 · abertos R$ 2.991.634,40
--   2025/1   9.859 tít / 2.840 CPFs / R$ 7.067.125,94 — negociado 81.775,48 · recebido 70.640,07 · abertos R$ 6.675.157,42
--   2025/2  11.485 tít / 3.058 CPFs / R$ 8.710.798,02 — negociado 400.887,90 · recebido 305.120,78 · abertos R$ 7.932.148,36
--
-- Só leitura. Aditivo: não toca em 2026/1 nem em 2026/2.
-- Reversível: drop function.
-- ============================================================================
begin;

create or replace function public.carteira_cobertura_historica()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with serie as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(semestre) semestre, max(liquidado_em) liq
      from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
  ),
  parc as (
    select acordo_id, coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas
      from public.parcelas group by 1
  ),
  acordo as (
    select a.id, case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                      then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                      when a.status = 'QUITADO' then 1 else 0 end ratio
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  t as (
    select t.id, lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') cpf,
           t.valor_original vo, coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo,
           t.situacao, t.created_at::date entrada,
           coalesce(t.acordo_id, v2.acordo_id) acordo_id,
           coalesce(s.semestre,
             case when t.vencimento is null then null
                  when extract(month from t.vencimento) <= 6 then extract(year from t.vencimento) || '/1'
                  else extract(year from t.vencimento) || '/2' end) safra,
           (s.b is not null) tem_linha_prime,
           (s.liq is not null and s.liq > t.vencimento + 30 and s.liq >= t.created_at::date) liq_real
      from public.acordos_titulos t
      left join public.acordo_titulo_vinculo v2 on v2.titulo_id = t.id and v2.ativo
      left join serie s on s.b = regexp_replace(coalesce(t.documento,''), '\D', '', 'g')
     where t.situacao <> 'DUPLICADA' and coalesce(t.tipo_boleto,'') <> 'Acordo'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'safra', safra,
           'titulos', titulos, 'cpfs', cpfs, 'valor_original', valor_original,
           'negociado', negociado, 'recebido', recebido,
           'abertos_titulos', abertos_titulos, 'abertos_valor', abertos_valor,
           'sem_linha_prime', sem_linha_prime,
           'entrada_de', entrada_de, 'entrada_ate', entrada_ate
         ) order by safra), '[]'::jsonb) into v
    from (
      select t.safra,
             count(*) titulos,
             count(distinct t.cpf) cpfs,
             round(sum(t.vo),2) valor_original,
             round(coalesce(sum(t.vo) filter (where t.acordo_id is not null),0),2) negociado,
             round(coalesce(sum(case when t.acordo_id is not null then t.vo * coalesce(ac.ratio,0)
                                     when t.situacao = 'PAGO' then greatest(t.vo - t.saldo, 0)
                                     else 0 end),0),2) recebido,
             count(*) filter (where t.tem_linha_prime and not t.liq_real) abertos_titulos,
             round(coalesce(sum(t.vo) filter (where t.tem_linha_prime and not t.liq_real),0),2) abertos_valor,
             count(*) filter (where not t.tem_linha_prime) sem_linha_prime,
             min(t.entrada) entrada_de, max(t.entrada) entrada_ate
        from t left join acordo ac on ac.id = t.acordo_id
       where t.safra in ('2024/1','2024/2','2025/1','2025/2')
       group by t.safra
    ) x;

  return jsonb_build_object('gerado_em', now(), 'safras', v);
end; $$;
revoke all on function public.carteira_cobertura_historica() from public, anon;
grant execute on function public.carteira_cobertura_historica() to authenticated;

do $$
declare v jsonb;
begin
  v := public.carteira_cobertura_historica();
  if jsonb_array_length(v->'safras') <> 4 then
    raise exception 'esperava 4 safras, veio %', jsonb_array_length(v->'safras');
  end if;
end $$;

commit;
