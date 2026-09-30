-- CORREÇÃO 2: `aluno_id` ambíguo, e o Perfil que nunca executava
-- ============================================================================
--
-- Duas falhas medidas em produção em 29/09/2026, depois que a correção do
-- `cpf` (20260929150001) destravou o ramo de 2024/2025:
--
-- 1. `sum(saldo) over (partition by aluno_id)` -- `aluno_id` também é coluna
--    de SAÍDA da função, e a referência nua é ambígua dentro do PL/pgSQL:
--      ERROR: 42702: column reference "aluno_id" is ambiguous
--    Mesma classe do `cpf`. Levantadas TODAS as referências nuas às colunas de
--    saída no corpo: são quatro, e três são apelidos de saída de CTE (não
--    criam ambiguidade). Esta era a única leitura ambígua restante.
--
-- 2. `carteira_academico_perfil` é STABLE e montava uma tabela temporária:
--      ERROR: 0A000: CREATE TABLE AS is not allowed in a non-volatile function
--    A função NUNCA executou, em recorte nenhum -- não era falha de 2024/2025.
--    O card inteiro do Perfil estava morto. Aqui a temporária dá lugar a uma
--    CTE `materialized`, e a função SEGUE STABLE.
--
-- NÃO MUDA regra de contagem (aluno único), agrupamento, rótulos, separação
-- entre consulta e importação, nem permissões. Nada financeiro é tocado.

create or replace function public.carteira_academico_universo(
  p_ano text, p_semestre text default null
) returns table (aluno_id uuid, cpf text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if p_ano = '2026' and coalesce(p_semestre,'1') = '1' then
    -- Mesma definição do card que já existe: CPF com saldo em aberto na
    -- classificação de 2026/1. `(array_agg(aluno_id))[1]` é o dedup que a
    -- `carteira_2026_1_academico` já usa -- repetido aqui de propósito, para
    -- os dois contarem igual.
    return query
      select (array_agg(c.aluno_id))[1], c.cpf
        from public.carteira_2026_1_classificar() c
       group by c.cpf
      having sum(c.inadimplencia + c.em_validacao) > 0.01;

  elsif p_ano = '2026' and p_semestre = '2' then
    -- A CARTEIRA de 2026/2, com o mesmo recorte de `carteira_2026_2_contexto`
    -- (que é quem produz o "1.910 alunos" do rodapé). Não é o subconjunto
    -- negociado.
    return query
      with serie as (
        select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(semestre) semestre
          from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
      ),
      t as (
        select lpad(regexp_replace(coalesce(nullif(tt.cpf,''), al.cpf, ''), '\D', '', 'g'), 11, '0') cpf,
               tt.aluno_id
          from public.acordos_titulos tt
          left join public.alunos al on al.id = tt.aluno_id
          left join serie s on s.b = regexp_replace(coalesce(tt.documento,''), '\D', '', 'g')
         where tt.situacao <> 'DUPLICADA'
           and coalesce(tt.tipo_boleto,'') <> 'Acordo'
           and coalesce(s.semestre,
                 case when tt.vencimento >= date '2026-07-01' and tt.vencimento < date '2027-01-01'
                      then '2026/2' end) = '2026/2'
      )
      select (array_agg(t.aluno_id) filter (where t.aluno_id is not null))[1], t.cpf
        from t group by t.cpf;

  elsif p_ano in ('2024','2025') then
    -- RECONSTRUÇÃO, com a MESMA regra que monta o snapshot histórico
    -- (`carteira_saldo_historico_recalcular`). Conferida em 29/09/2026: 1.979
    -- alunos em 2024 e 2.889 em 2025, iguais ao snapshot.
    --
    -- O snapshot NÃO é alterado por esta função. Ele continua sendo a fonte do
    -- financeiro; aqui ele serve só de comparação, e a lista carrega a data da
    -- PRÓPRIA reconstrução -- nunca a do snapshot. Uma lista de agora não é o
    -- detalhamento exato de um agregado tirado em outro instante.
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
      select (array_agg(c.aluno_id))[1], c.cpf
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
    -- Recorte que não existe devolve VAZIO, nunca a carteira inteira: um
    -- parâmetro errado não pode virar um painel cheio de gente que não é do
    -- recorte.
    return;
  end if;
end;
$$;

comment on function public.carteira_academico_universo(text,text) is
  'Alunos únicos da carteira de um recorte (2024, 2025, 2026/1, 2026/2). Contagem por aluno, nunca por vínculo ou curso. 2026/2 é a CARTEIRA do semestre, não os negociados. Sem filtro de mês.';

create or replace function public.carteira_academico_perfil(
  p_ano text, p_semestre text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  -- UMA CONSULTA SÓ, com CTE. A versão anterior montava `create temp table
  -- _uni` e por isso NUNCA executava: `CREATE TABLE AS` é proibido em função
  -- não-volátil, e esta é STABLE de propósito -- ela só lê.
  --
  -- `materialized` não é enfeite: `carteira_academico_grupo` é chamada UMA VEZ
  -- POR ALUNO, e `uni` é referenciada três vezes abaixo. Sem materializar, o
  -- planejador expandiria a CTE em cada referência e o custo triplicaria.
  with uni as materialized (
    select u.aluno_id, u.cpf, public.carteira_academico_grupo(u.aluno_id) grupo
      from public.carteira_academico_universo(p_ano, p_semestre) u
  ),
  tot as (
    select count(*)::integer n from uni
  ),
  agrupado as (
    select uni.grupo, count(*)::integer n,
           case
             when uni.grupo like 'Status identificado%' then 0
             when uni.grupo = 'Múltiplas situações'     then 1
             when uni.grupo = 'Informação incompleta'   then 2
             when uni.grupo = 'Sem resultado na busca'  then 3
             when uni.grupo = 'Consulta indisponível'   then 4
             else 5 end ordem
      from uni group by uni.grupo
  )
  select jsonb_build_object(
    'recorte', case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end,
    -- A lista é reconstruída AGORA. Em 2024/2025 o agregado financeiro vem de
    -- um snapshot tirado em outro instante; por isso a data é desta consulta, e
    -- a tela precisa dizer isso em vez de herdar a data do snapshot.
    'reconstruido_em', now(),
    'total_alunos', t.n,
    -- GRUPOS DA API. Somam exatamente `total_alunos`.
    'grupos', coalesce((
      select jsonb_agg(jsonb_build_object('grupo', a.grupo, 'alunos', a.n,
                                          'pct', round(100.0*a.n/nullif(t.n,0),1))
                       order by a.ordem, a.n desc)
        from agrupado a
    ), '[]'::jsonb),
    -- IMPORTAÇÃO, À PARTE e rotulada. Não entra na soma dos grupos e não
    -- preenche buraco nenhum -- está aqui só para a tela poder mostrar de onde
    -- vinha o rótulo antigo, com a data da importação.
    'importacao', jsonb_build_object(
      'fonte', 'Relatório de inadimplência (importação)',
      'atualizado_em', (select max(al.academico_atualizado_em) from public.alunos al
                         join uni x on x.aluno_id = al.id),
      'situacoes', coalesce((
        select jsonb_agg(jsonb_build_object('situacao', i.s, 'alunos', i.n) order by i.n desc)
          from (select coalesce(al.situacao_academica, '(sem situação importada)') s, count(*) n
                  from uni x join public.alunos al on al.id = x.aluno_id
                 group by 1) i
      ), '[]'::jsonb)
    )
  ) into v_out
  from tot t;

  return v_out;
end;
$$;

comment on function public.carteira_academico_perfil(text,text) is
  'Perfil dos alunos por recorte: grupos vindos da CONSULTA ao Prime (somam o total de alunos únicos) e, à parte e rotulada, a distribuição que veio da importação. Os dois nunca se somam.';

revoke all on function public.carteira_academico_universo(text,text) from public, anon;
revoke all on function public.carteira_academico_perfil(text,text) from public, anon;
grant execute on function public.carteira_academico_universo(text,text) to authenticated, service_role;
grant execute on function public.carteira_academico_perfil(text,text) to authenticated, service_role;
