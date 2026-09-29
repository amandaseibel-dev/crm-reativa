-- CORREÇÃO: referência ambígua a `cpf` em carteira_academico_universo
-- ============================================================================
--
-- O DEFEITO. `carteira_academico_universo` declara `cpf` como coluna de SAÍDA
-- (`returns table (aluno_id uuid, cpf text)`). No ramo de 2024/2025 a CTE
-- `m166` lia `regexp_replace(cpf, ...)` SEM qualificar, e dentro do PL/pgSQL
-- essa referência é ambígua entre a coluna de saída e
-- `prime_portador_membro.cpf`. O ramo não executava:
--
--   ERROR: 42702: column reference "cpf" is ambiguous
--
-- Só 2024 e 2025 quebravam -- a CTE `m166` não existe nos outros dois ramos.
-- Medido em produção em 29/09/2026: 2026/1 e 2026/2 responderam (2.553 e
-- 1.910 alunos); 2024 e 2025 falharam.
--
-- POR QUE ESTE ARQUIVO REESCREVE AS QUATRO FUNÇÕES, e não só a defeituosa.
-- A `20260929114756` foi aplicada em produção como versão REAL 20260929143126,
-- e o texto aplicado não era idêntico ao do arquivo: ao passar o SQL pelo MCP
-- o delimitador virou `$mig$`, `'\D'` virou `E'\\D'` e os comentários foram
-- removidos. Conferido por md5 do corpo: das quatro funções, só
-- `carteira_academico_grupo` batia byte a byte com o repositório.
--
-- Deixar assim é o começo de uma divergência silenciosa: o repositório
-- deixaria de descrever o que roda. Este arquivo reinstala as quatro a partir
-- do texto versionado, e depois de aplicado o md5 de cada corpo em produção
-- tem de ser igual ao md5 do corpo aqui.
--
-- NÃO MUDA COMPORTAMENTO além do `cpf` qualificado. Nenhum cálculo
-- financeiro, tabulação, saldo ou cobrança é tocado.

-- PERFIL DOS ALUNOS na Efetividade da Cobrança, a partir da consulta ao Prime
-- ============================================================================
--
-- O QUE MUDA. O card "Perfil dos alunos" hoje diz "Situação acadêmica do Prime"
-- e não é verdade: ele mistura `alunos.situacao_academica` (importação do
-- relatório de inadimplência) com `prime_contratos.status` (status de CONTRATO
-- por semestre). Nenhum dos dois é situação acadêmica consultada na API.
--
-- Aqui entram os grupos vindos da CONSULTA (prime_academico_consulta /
-- _vinculo), separados do que veio de importação. Os dois nunca se misturam
-- num número só: quem ainda não foi consultado continua identificado assim, e
-- NÃO é preenchido com status de contrato.
--
-- A CONTAGEM PRINCIPAL É ALUNO ÚNICO. A consulta ao Prime é por aluno, e um
-- aluno com seis vínculos de curso continua sendo um aluno. Nada aqui conta
-- vínculo nem multiplica aluno por curso.
--
-- O QUE ISTO NÃO FAZ: não escreve em `alunos`, não toca tabulação, saldo,
-- cobrança nem nenhum cálculo financeiro. Não altera o snapshot histórico --
-- ele é lido só para comparação.

-- ---------------------------------------------------------------------------
-- 1. UNIVERSO -- os alunos da carteira de um recorte
-- ---------------------------------------------------------------------------
-- Quatro recortes, e cada um tem a sua fonte. Escrever os quatro numa função
-- só é o que garante que o card, o detalhamento e a fila do piloto contem
-- exatamente a MESMA gente -- se cada um montasse o seu, divergiriam com o
-- tempo e ninguém notaria.
--
-- O recorte de 2026/2 é a CARTEIRA do semestre (1.910 alunos), não os
-- negociados (261). A "visão" da tela (Consolidado / Por competência) NÃO muda
-- universo: ela troca o painel inteiro -- na visão por competência o Perfil
-- nem é renderizado. Por isso esta função não tem parâmetro de visão, e não
-- aplica filtro de mês nenhum. Se um dia o Perfil for para aquela visão, o mês
-- selecionado terá de entrar aqui COMO PARÂMETRO e aparecer escrito no card.
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
        select *, sum(saldo) over (partition by aluno_id) devido_total
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

-- ---------------------------------------------------------------------------
-- 2. CLASSIFICAÇÃO de um aluno pela consulta ao Prime
-- ---------------------------------------------------------------------------
-- Um aluno, um grupo. Extraída para o card e o detalhamento nunca divergirem.
--
-- A ORDEM DOS TESTES É A REGRA, e cada linha existe por um motivo:
--   sem consulta          -> "Ainda não consultados". NUNCA preenchido com
--                            status de contrato nem com o da importação
--   sem completa, com parcial -> "Informação incompleta" (há dado, mas a lista
--                            reconhecidamente não está inteira)
--   sem completa, só falha -> "Consulta indisponível" (não se sabe nada)
--   completa SEM_RESULTADO -> "Sem resultado na busca"
--   completa com algum nulo -> "Informação incompleta"
--   completa, >1 situação  -> "Múltiplas situações"
--   completa, 1 situação   -> "Status identificado: <nome do Prime>"
create or replace function public.carteira_academico_grupo(p_aluno_id uuid)
returns text
language sql
stable
security invoker
set search_path to 'public'
as $$
  with ultima_completa as (
    select id, resultado from public.prime_academico_consulta
     where aluno_id = p_aluno_id and resultado in ('COM_VINCULOS','SEM_RESULTADO')
     order by consultado_em desc, id desc limit 1
  ),
  existe as (
    select bool_or(true) tem,
           bool_or(resultado = 'PAGINACAO_INCOMPLETA') tem_parcial
      from public.prime_academico_consulta where aluno_id = p_aluno_id
  ),
  v as (
    select count(*) filter (where v.status is null) nulos,
           count(distinct v.status) distintos,
           min(v.status) unico
      from ultima_completa c join public.prime_academico_vinculo v on v.consulta_id = c.id
  )
  select case
    when not coalesce((select tem from existe), false)      then 'Ainda não consultados'
    when (select id from ultima_completa) is null
         and coalesce((select tem_parcial from existe), false) then 'Informação incompleta'
    when (select id from ultima_completa) is null           then 'Consulta indisponível'
    when (select resultado from ultima_completa) = 'SEM_RESULTADO' then 'Sem resultado na busca'
    when coalesce((select nulos from v), 0) > 0             then 'Informação incompleta'
    when coalesce((select distintos from v), 0) > 1         then 'Múltiplas situações'
    else 'Status identificado: ' || coalesce((select unico from v), '—')
  end;
$$;

comment on function public.carteira_academico_grupo(uuid) is
  'Grupo de UM aluno pela consulta ao Prime. Aluno sem consulta fica "Ainda não consultados" -- nunca preenchido com status de contrato ou de importação.';

-- ---------------------------------------------------------------------------
-- 3. O CARD -- grupos da API, e à parte o que veio de importação
-- ---------------------------------------------------------------------------
-- Os dois blocos vêm SEPARADOS no mesmo objeto, e é de propósito: a tela
-- precisa mostrar a situação consultada sem que ela se confunda com o rótulo
-- antigo. Somar um no outro produziria um número que não é de fonte nenhuma.
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
  v_total integer;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  create temp table _uni on commit drop as
    select u.aluno_id, u.cpf, public.carteira_academico_grupo(u.aluno_id) grupo
      from public.carteira_academico_universo(p_ano, p_semestre) u;

  select count(*) into v_total from _uni;

  select jsonb_build_object(
    'recorte', case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end,
    -- A lista é reconstruída AGORA. Em 2024/2025 o agregado financeiro vem de
    -- um snapshot tirado em outro instante; por isso a data é desta consulta, e
    -- a tela precisa dizer isso em vez de herdar a data do snapshot.
    'reconstruido_em', now(),
    'total_alunos', v_total,
    -- GRUPOS DA API. Somam exatamente `total_alunos`.
    'grupos', coalesce((
      select jsonb_agg(jsonb_build_object('grupo', grupo, 'alunos', n,
                                          'pct', round(100.0*n/nullif(v_total,0),1))
                       order by ordem, n desc)
        from (
          select grupo, count(*) n,
                 case
                   when grupo like 'Status identificado%' then 0
                   when grupo = 'Múltiplas situações'     then 1
                   when grupo = 'Informação incompleta'   then 2
                   when grupo = 'Sem resultado na busca'  then 3
                   when grupo = 'Consulta indisponível'   then 4
                   else 5 end ordem
            from _uni group by grupo
        ) g
    ), '[]'::jsonb),
    -- IMPORTAÇÃO, À PARTE e rotulada. Não entra na soma dos grupos e não
    -- preenche buraco nenhum -- está aqui só para a tela poder mostrar de onde
    -- vinha o rótulo antigo, com a data da importação.
    'importacao', jsonb_build_object(
      'fonte', 'Relatório de inadimplência (importação)',
      'atualizado_em', (select max(a.academico_atualizado_em) from public.alunos a
                         join _uni x on x.aluno_id = a.id),
      'situacoes', coalesce((
        select jsonb_agg(jsonb_build_object('situacao', s, 'alunos', n) order by n desc)
          from (select coalesce(a.situacao_academica, '(sem situação importada)') s, count(*) n
                  from _uni x join public.alunos a on a.id = x.aluno_id
                 group by 1) i
      ), '[]'::jsonb)
    )
  ) into v_out;

  return v_out;
end;
$$;

comment on function public.carteira_academico_perfil(text,text) is
  'Perfil dos alunos por recorte: grupos vindos da CONSULTA ao Prime (somam o total de alunos únicos) e, à parte e rotulada, a distribuição que veio da importação. Os dois nunca se somam.';

-- ---------------------------------------------------------------------------
-- 4. DETALHAMENTO -- os alunos de um grupo
-- ---------------------------------------------------------------------------
create or replace function public.carteira_academico_detalhe(
  p_ano text, p_semestre text, p_grupo text, p_limite integer default 500
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'grupo', p_grupo,
    'reconstruido_em', now(),
    'alunos', coalesce(jsonb_agg(x order by x->>'nome'), '[]'::jsonb)
  ) into v_out
  from (
    select jsonb_build_object(
      'aluno_id', u.aluno_id,
      'nome', coalesce(a.nome, a.nome_aluno),
      'cpf_mascarado', a.cpf_mascarado,
      -- SITUAÇÕES ENCONTRADAS: todas, na ordem da API, sem escolher uma. Um
      -- vínculo sem situação aparece como tal, não some da lista.
      'situacoes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'curso', v.curso, 'campus', v.campus, 'turno', v.turno,
                 'status', v.status, 'matricula', v.registration) order by v.ordem)
          from public.prime_academico_consulta c
          join public.prime_academico_vinculo v on v.consulta_id = c.id
         where c.id = (select c2.id from public.prime_academico_consulta c2
                        where c2.aluno_id = u.aluno_id
                          and c2.resultado in ('COM_VINCULOS','SEM_RESULTADO')
                        order by c2.consultado_em desc, c2.id desc limit 1)
      ), '[]'::jsonb),
      'fonte', (select c.fonte from public.prime_academico_consulta c
                 where c.aluno_id = u.aluno_id
                 order by c.consultado_em desc, c.id desc limit 1),
      'consultado_em', (select c.consultado_em from public.prime_academico_consulta c
                         where c.aluno_id = u.aluno_id
                         order by c.consultado_em desc, c.id desc limit 1),
      -- de importação, rotulado como tal -- nunca apresentado como Prime
      'situacao_importada', a.situacao_academica,
      'importado_em', a.academico_atualizado_em
    ) x
    from public.carteira_academico_universo(p_ano, p_semestre) u
    join public.alunos a on a.id = u.aluno_id
   where public.carteira_academico_grupo(u.aluno_id) = p_grupo
   limit greatest(1, least(coalesce(p_limite,500), 2000))
  ) s;

  return v_out;
end;
$$;

comment on function public.carteira_academico_detalhe(text,text,text,integer) is
  'Alunos de um grupo, com TODAS as situações encontradas, fonte e data da consulta. `situacao_importada` vem rotulada como importação, nunca como Prime.';

-- ---------------------------------------------------------------------------
-- 5. PERMISSÕES
-- ---------------------------------------------------------------------------
revoke all on function public.carteira_academico_universo(text,text) from public, anon;
revoke all on function public.carteira_academico_perfil(text,text) from public, anon;
revoke all on function public.carteira_academico_detalhe(text,text,text,integer) from public, anon;
revoke all on function public.carteira_academico_grupo(uuid) from public, anon;
grant execute on function public.carteira_academico_universo(text,text) to authenticated, service_role;
grant execute on function public.carteira_academico_perfil(text,text) to authenticated, service_role;
grant execute on function public.carteira_academico_detalhe(text,text,text,integer) to authenticated, service_role;
grant execute on function public.carteira_academico_grupo(uuid) to authenticated, service_role;
