-- EFETIVIDADE EXECUTIVA -- composicao academica do saldo em aberto e abertura
-- de `Pendente` pelos submotivos reais, com acesso ao registro individual.
--
-- POR QUE ESTAS TRES FUNCOES EXISTEM. A Efetividade respondia "quanto esta em
-- aberto" e "quanto esta pendente de classificacao" com um total unico. Quem
-- compoe o saldo e por que o pendente esta pendente so existia no banco, titulo
-- a titulo, sem caminho de tela. Pedido da gestao em 07/10/2026: a Efetividade
-- vira tela de ANALISE (quem compoe, por que esta pendente) e a Fila Unica vira
-- a tela de TRATAMENTO (o registro individual, com a acao que a regra permite).
--
-- NENHUMA REGRA DE NEGOCIO NOVA. As tres funcoes leem o MESMO universo que
-- `carteira_safra_situacoes(ano, semestre)` ja publica, com o MESMO recorte, as
-- MESMAS exclusoes e as MESMAS formulas -- copiadas verbatim do corpo daquela
-- funcao, de proposito, para que o fechamento nao dependa de nenhuma reescrita.
-- Nada aqui reclassifica titulo, nem cria faixa, nem inventa submotivo: os
-- submotivos sao exatamente as parcelas que `pendente_detalhe` ja devolvia.
--
-- ============================ O QUE FECHA, E POR QUE ========================
-- A composicao academica fecha AO CENTAVO por CONSTRUCAO, nao por conferencia a
-- posteriori: cada titulo do universo em aberto entra em UMA linha de status --
-- a situacao academica do SEU aluno -- e a linha soma o mesmo `valor` que o
-- balde "em aberto" soma. Nao ha titulo em duas linhas e nao ha titulo fora de
-- linha, porque `(sem situacao importada)` recebe todo aluno sem situacao em vez
-- de descarta-lo. O bloco `conferencia` mede isso a cada chamada e REGISTRA a
-- diferenca; nao corrige nada -- se um dia divergir, a tela mostra o aviso e os
-- numeros seguem como vieram.
--
-- AS CATEGORIAS SAO AS DA BASE. O rotulo e `alunos.situacao_academica` verbatim,
-- sem agrupar, sem traduzir e sem "Outros": "Aguardando Matricula" e
-- "Matriculado Curso Normal" continuam duas linhas, como na origem. Aluno sem
-- situacao importada cai em `(sem situacao importada)`, que e uma categoria como
-- qualquer outra -- e justamente a que mede o buraco de cobertura de 2024.
--
-- A SITUACAO ACADEMICA E FOTOGRAFIA, NAO CONSULTA DE HOJE. Ela vem da
-- importacao do relatorio academico, e as funcoes devolvem
-- `fonte_academica.importacao_atualizada_em` = max(alunos.academico_atualizado_em)
-- do proprio universo, para a tela poder dizer a data em vez de sugerir consulta
-- ao vivo. O dado FINANCEIRO, ao contrario, e lido ao vivo a cada chamada --
-- igual a `carteira_safra_situacoes`, e pelo mesmo motivo.
--
-- ================================= RECORTES ================================
--   2026/1   universo em aberto = inadimplencia + em_validacao, pela regra
--            especifica da safra (a validacao ainda e exposicao em aberto);
--            fonte `carteira_2026_1_classificar()` AO VIVO.
--   2024/25  universo em aberto = o balde "em aberto" das seis linhas (saldo sem
--            acordo ativo, fora cancelado/em confirmacao/pago sem lastro);
--            fonte `acordos_titulos` + serie da Prime, ao vivo.
--   2026/2   RECUSADO de proposito: aquela safra nao tem fonte academica
--            equivalente, e forcar status sem fonte seria inventar cobertura.
--            A funcao levanta excecao com a razao, em vez de devolver vazio --
--            vazio e indistinguivel de "nao ha ninguem".
--
-- ========================= PENDENTE: OS SUBMOTIVOS =========================
-- Sao os que `carteira_safra_situacoes.pendente_detalhe` ja publicava, nenhum a
-- mais:
--   2026/1   em_validacao, ajuste_academico, convertido_origem_comprovada
--   2024/25  em_confirmacao, pago_sem_lastro
--
-- OS VALORES DOS SUBMOTIVOS SAO DISJUNTOS e somam exatamente `pendente`: em
-- 2026/1 cada um e uma COLUNA distinta da mesma linha classificada
-- (em_validacao, academico, ef_convertido), e em 2024/2025 cada titulo cai em um
-- unico submotivo. Por isso `conferencia` fecha. As CONTAGENS de titulo e de
-- aluno, porem, nao somam entre submotivos em 2026/1 -- o mesmo titulo pode ter
-- valor em dois -- e as funcoes dizem isso em `contagens_somaveis`, para a tela
-- nao prometer soma que nao existe.
--
-- ============================== ACAO POR SUBMOTIVO =========================
-- Cada submotivo declara, no proprio retorno, a acao que a regra JA EXISTENTE
-- permite. Nenhuma acao nova e criada aqui, e nenhuma acao generica de "editar
-- valor ou status" existe:
--   em_confirmacao ....... CONFERENCIA_PRIME -- o fluxo de
--                          `conferencia_em_confirmacao_do_aluno` +
--                          `prime_conferencia_vincular/seguir_pagamento/rejeitar`,
--                          que ja roda na Fila do extrato e na ficha do aluno,
--                          com motivo obrigatorio e auditoria.
--   pago_sem_lastro ...... SEM_ACAO_AUTOMATICA_SEGURA. Existe rotina
--                          (`mensalidade_reconciliar_pago_sem_lastro`), mas ela
--                          opera um LOTE CONGELADO de 491 titulos sob criterio
--                          de causalidade proprio e autorizacao separada da
--                          gestao financeira -- nao e acao por caso, e nao cobre
--                          esta populacao. Entra na fila com motivo e evidencia.
--   em_validacao ......... SEM_ACAO_AUTOMATICA_SEGURA (classificacao de 2026/1;
--                          nao ha RPC de resolucao por caso).
--   ajuste_academico ..... SEM_ACAO_AUTOMATICA_SEGURA.
--   convertido_origem_
--   comprovada ........... SEM_ACAO_AUTOMATICA_SEGURA (sabe-se que converteu,
--                          nao se sabe se por pagamento ou por acordo).
--
-- O QUE ESTAS FUNCOES NAO FAZEM: nao escrevem, nao corrigem titulo, nao tocam
-- `carteira_safra_situacoes`, `carteira_2026_1_indicadores`,
-- `carteira_saldo_historico_por_ano`, `carteira_2026_2_*`,
-- `carteira_academico_perfil*` nem `casos_pendentes_contar`. Todas sao STABLE e
-- so leem. SO DDL: tres funcoes novas.
--
-- Reversivel: supabase/rollbacks/20261007193000_*.rollback.sql derruba as tres.

-- ===========================================================================
-- 0. O CATALOGO DOS SUBMOTIVOS -- rotulo e acao em UM lugar so
-- ===========================================================================
-- Rotulo e acao moram aqui, e nao no front, por dois motivos: o resumo da
-- Efetividade e a Fila Unica tem de dizer a MESMA coisa sobre o mesmo submotivo
-- (dois catalogos divergiriam na primeira correcao), e "qual acao a regra
-- permite" e decisao de regra, nao de tela. O front recebe a acao e desenha o
-- botao correspondente; se a acao e SEM_ACAO_AUTOMATICA_SEGURA, nao ha botao
-- nenhum para desenhar -- e e isso que impede a tela de inventar uma acao
-- generica que so edite valor ou status.
create or replace function public.carteira_pendencia_rotulo(p_motivo text)
returns text
language sql
immutable
as $function$
  select case p_motivo
    when 'em_validacao'                 then 'Em validação'
    when 'ajuste_academico'             then 'Ajuste acadêmico'
    when 'convertido_origem_comprovada' then 'Conversão com origem comprovada, sem natureza definida'
    when 'em_confirmacao'               then 'Em confirmação de pagamento'
    when 'pago_sem_lastro'              then 'Pago sem lastro'
    else p_motivo
  end
$function$;

comment on function public.carteira_pendencia_rotulo(text) is
  'Rotulo de exibicao de cada submotivo de Pendente. Nomenclatura identica a que '
  'carteira_safra_situacoes.pendente_detalhe e a tela das seis linhas ja usavam.';

-- Acoes possiveis, e so estas:
--   CONFERENCIA_PRIME ............ resolve pelo fluxo existente de EM_CONFIRMACAO
--                                  (conferencia_em_confirmacao_do_aluno +
--                                  prime_conferencia_vincular / _seguir_pagamento /
--                                  _rejeitar), com motivo obrigatorio e auditoria.
--   SEM_ACAO_AUTOMATICA_SEGURA ... nao existe regra de resolucao por caso. Entra
--                                  na fila com motivo e evidencia, para analise
--                                  humana -- e NAO ganha botao.
create or replace function public.carteira_pendencia_acao(p_motivo text)
returns text
language sql
immutable
as $function$
  select case p_motivo
    when 'em_confirmacao' then 'CONFERENCIA_PRIME'
    else 'SEM_ACAO_AUTOMATICA_SEGURA'
  end
$function$;

comment on function public.carteira_pendencia_acao(text) is
  'A acao que a regra JA EXISTENTE permite para cada submotivo de Pendente. Hoje so '
  'em_confirmacao tem caminho seguro por caso (Conferencia Prime). Os outros quatro '
  'sao SEM_ACAO_AUTOMATICA_SEGURA de proposito: inventar acao generica que edite '
  'valor ou status final e exatamente o que nao se pode fazer.';

revoke all on function public.carteira_pendencia_rotulo(text) from public, anon;
revoke all on function public.carteira_pendencia_acao(text) from public, anon;
grant execute on function public.carteira_pendencia_rotulo(text) to authenticated, service_role;
grant execute on function public.carteira_pendencia_acao(text) to authenticated, service_role;


-- ===========================================================================
-- 1. COMPOSICAO DO SALDO EM ABERTO POR STATUS ACADEMICO
-- ===========================================================================
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
  -- Mesmo portao das outras telas de carteira: gestao, diretoria ou service_role.
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

  -- ------------------------------------------------------------------ 2026/1
  if v_ano = '2026' and v_sem = '1' then
    with c as (select * from public.carteira_2026_1_classificar()),
    -- O universo EM ABERTO de 2026/1 inclui a validacao: ela e exposicao ainda
    -- nao recebida, pela regra especifica desta safra.
    abertos as (
      select c.aluno_id, c.titulo_id, (c.inadimplencia + c.em_validacao) as valor
        from c
       where c.inadimplencia + c.em_validacao > 0
    ),
    -- UMA linha por titulo, e o status e o do aluno DAQUELE titulo. Sem
    -- situacao importada e categoria, nao descarte -- e por isso que a soma
    -- das linhas e identica ao total.
    porstatus as (
      select coalesce(nullif(btrim(al.situacao_academica), ''), '(sem situação importada)') as status,
             a.aluno_id, a.titulo_id, a.valor
        from abertos a
        left join public.alunos al on al.id = a.aluno_id
    ),
    linhas as (
      select status,
             count(distinct aluno_id)  as alunos,
             count(distinct titulo_id) as titulos,
             round(sum(valor), 2)      as valor
        from porstatus group by status
    ),
    tot as (
      select count(distinct aluno_id)  as alunos,
             count(distinct titulo_id) as titulos,
             round(sum(valor), 2)      as valor
        from abertos
    ),
    fonte as (
      select max(al.academico_atualizado_em) as atualizado_em
        from (select distinct aluno_id from abertos) u
        join public.alunos al on al.id = u.aluno_id
    )
    select jsonb_build_object(
      'recorte',  '2026/1',
      'natureza', 'CARTEIRA_CONSOLIDADA',
      'fonte',    'carteira_2026_1_classificar() ao vivo',
      'universo_em_aberto', 'inadimplencia + em_validacao',
      'gerado_em', now(),
      'total', (select jsonb_build_object('alunos', alunos, 'titulos', titulos,
                                          'valor', coalesce(valor, 0)) from tot),
      'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                    'status', status, 'alunos', alunos,
                    'titulos', titulos, 'valor', valor)
                    order by valor desc, status), '[]'::jsonb) from linhas),
      'conferencia', (select jsonb_build_object(
                    'total_valor',      coalesce(t.valor, 0),
                    'soma_das_linhas',  coalesce((select round(sum(valor), 2) from linhas), 0),
                    'diferenca',        round(coalesce(t.valor, 0)
                                              - coalesce((select sum(valor) from linhas), 0), 2),
                    'fecha',            round(coalesce(t.valor, 0)
                                              - coalesce((select sum(valor) from linhas), 0), 2) = 0,
                    'titulos_total',    t.titulos,
                    'titulos_soma',     coalesce((select sum(titulos) from linhas), 0))
                    from tot t),
      'fonte_academica', (select jsonb_build_object(
                    'importacao_atualizada_em', atualizado_em) from fonte)
    ) into v_out;
    return v_out;
  end if;

  -- --------------------------------------------------------------- 2024/2025
  if v_ano not in ('2024', '2025') then
    raise exception 'Safra sem regua definida: %. Use 2024, 2025 ou 2026/1.', v_ano
      using errcode = '22023';
  end if;

  -- Universo COPIADO VERBATIM de carteira_safra_situacoes(2024/2025). Qualquer
  -- divergencia aqui seria divergencia de total com as seis linhas, e e
  -- exatamente isso que nao pode acontecer.
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
           (sit = 'CANCELADA')      as eh_cancelado,
           (sit = 'EM_CONFIRMACAO') as eh_confirm,
           (sit = 'PAGO' and not tem_acordo and not liq_prime and pago_direto = 0) as pago_sem_lastro,
           least(case when tem_acordo              then vo * ratio
                      when liq_prime or pago_direto > 0 then least(pago_direto, vo)
                      else 0 end, vo) as recuperado
      from t
  ),
  n as (
    select *, (eh_cancelado or eh_confirm or pago_sem_lastro) as fora,
              greatest(vo - recuperado, 0) as resto
      from m
  ),
  abertos as (
    select aluno_id, titulo_id, resto as valor
      from n
     where not fora and not acordo_ativo and resto > 0
  ),
  porstatus as (
    select coalesce(nullif(btrim(al.situacao_academica), ''), '(sem situação importada)') as status,
           a.aluno_id, a.titulo_id, a.valor
      from abertos a
      left join public.alunos al on al.id = a.aluno_id
  ),
  linhas as (
    select status,
           count(distinct aluno_id)  as alunos,
           count(distinct titulo_id) as titulos,
           round(sum(valor), 2)      as valor
      from porstatus group by status
  ),
  tot as (
    select count(distinct aluno_id)  as alunos,
           count(distinct titulo_id) as titulos,
           round(sum(valor), 2)      as valor
      from abertos
  ),
  fonte as (
    select max(al.academico_atualizado_em) as atualizado_em
      from (select distinct aluno_id from abertos) u
      join public.alunos al on al.id = u.aluno_id
  )
  select jsonb_build_object(
    'recorte',  v_ano,
    'natureza', 'COBERTURA_HISTORICA',
    'fonte',    'acordos_titulos + serie da Prime, ao vivo',
    'universo_em_aberto', 'saldo sem acordo ativo (balde "em aberto" das seis linhas)',
    'gerado_em', now(),
    'total', (select jsonb_build_object('alunos', alunos, 'titulos', titulos,
                                        'valor', coalesce(valor, 0)) from tot),
    'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                  'status', status, 'alunos', alunos,
                  'titulos', titulos, 'valor', valor)
                  order by valor desc, status), '[]'::jsonb) from linhas),
    'conferencia', (select jsonb_build_object(
                  'total_valor',     coalesce(t.valor, 0),
                  'soma_das_linhas', coalesce((select round(sum(valor), 2) from linhas), 0),
                  'diferenca',       round(coalesce(t.valor, 0)
                                           - coalesce((select sum(valor) from linhas), 0), 2),
                  'fecha',           round(coalesce(t.valor, 0)
                                           - coalesce((select sum(valor) from linhas), 0), 2) = 0,
                  'titulos_total',   t.titulos,
                  'titulos_soma',    coalesce((select sum(titulos) from linhas), 0))
                  from tot t),
    'fonte_academica', (select jsonb_build_object(
                  'importacao_atualizada_em', atualizado_em) from fonte)
  ) into v_out;

  return v_out;
end;
$function$;

comment on function public.carteira_em_aberto_por_status_academico(text, text) is
  'Composicao FINANCEIRA do saldo em aberto por situacao academica real, por safra '
  '(2024, 2025, 2026/1). Mesmo universo e mesmas formulas de carteira_safra_situacoes; '
  'em 2026/1 o aberto inclui em_validacao, pela regra da safra. Cada titulo entra em '
  'UMA linha (o status do seu aluno) e aluno sem situacao cai em "(sem situacao '
  'importada)", nunca descartado -- por isso a soma das linhas e identica ao total, e '
  '`conferencia` mede isso a cada chamada sem corrigir nada. Categorias sao os rotulos '
  'verbatim de alunos.situacao_academica, sem agrupamento. 2026/2 levanta excecao: nao '
  'tem fonte academica equivalente. SO LEITURA.';

revoke all on function public.carteira_em_aberto_por_status_academico(text, text) from public, anon;
grant execute on function public.carteira_em_aberto_por_status_academico(text, text) to authenticated, service_role;


-- ===========================================================================
-- 2. PENDENTE ABERTO PELOS SUBMOTIVOS REAIS
-- ===========================================================================
create or replace function public.carteira_pendencias_por_motivo(
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

  -- ------------------------------------------------------------------ 2026/1
  if v_ano = '2026' and v_sem = '1' then
    with c as (select * from public.carteira_2026_1_classificar()),
    -- Um registro por (titulo, submotivo). Os VALORES sao disjuntos -- colunas
    -- diferentes da mesma linha -- e somam `pendente`. As CONTAGENS nao somam
    -- entre submotivos, e o retorno declara isso.
    b as (
      select 'em_validacao' as motivo, aluno_id, titulo_id, em_validacao as valor
        from c where em_validacao > 0
      union all
      select 'ajuste_academico', aluno_id, titulo_id, academico from c where academico > 0
      union all
      select 'convertido_origem_comprovada', aluno_id, titulo_id, ef_convertido
        from c where ef_convertido > 0
    ),
    linhas as (
      select motivo,
             count(distinct aluno_id)  as alunos,
             count(distinct titulo_id) as titulos,
             round(sum(valor), 2)      as valor
        from b group by motivo
    ),
    tot as (
      select round(sum(em_validacao + academico + ef_convertido), 2) as valor,
             count(distinct aluno_id) filter
               (where em_validacao + academico + ef_convertido > 0) as alunos,
             count(distinct titulo_id) filter
               (where em_validacao + academico + ef_convertido > 0) as titulos
        from c
    )
    select jsonb_build_object(
      'recorte', '2026/1', 'gerado_em', now(),
      'fonte', 'carteira_2026_1_classificar() ao vivo',
      'contagens_somaveis', false,
      'total', (select jsonb_build_object('alunos', alunos, 'titulos', titulos,
                                          'valor', coalesce(valor, 0)) from tot),
      'motivos', (select coalesce(jsonb_agg(jsonb_build_object(
                     'chave',   motivo,
                     'rotulo',  public.carteira_pendencia_rotulo(motivo),
                     'acao',    public.carteira_pendencia_acao(motivo),
                     'alunos',  alunos, 'titulos', titulos, 'valor', valor)
                     order by valor desc), '[]'::jsonb) from linhas),
      'conferencia', (select jsonb_build_object(
                     'total_valor',     coalesce(t.valor, 0),
                     'soma_das_linhas', coalesce((select round(sum(valor), 2) from linhas), 0),
                     'diferenca',       round(coalesce(t.valor, 0)
                                              - coalesce((select sum(valor) from linhas), 0), 2),
                     'fecha',           round(coalesce(t.valor, 0)
                                              - coalesce((select sum(valor) from linhas), 0), 2) = 0)
                     from tot t)
    ) into v_out;
    return v_out;
  end if;

  -- --------------------------------------------------------------- 2024/2025
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
  t as (
    select t.id as titulo_id, t.aluno_id, t.valor_original vo,
           upper(coalesce(t.situacao, '')) sit,
           (t.acordo_id is not null) tem_acordo,
           coalesce(pg.pago, 0) pago_direto,
           (t.origem_liquidacao is not null) liq_prime
      from public.acordos_titulos t
      left join ts on ts.b = regexp_replace(coalesce(t.documento, ''), '\D', '', 'g')
      left join pag pg on pg.b = regexp_replace(coalesce(t.documento, ''), '\D', '', 'g')
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and (t.tipo_boleto ilike 'Cursos de Gradua%' or t.tipo_boleto ilike 'Cursos de P%s Gradua%')
       and left(ts.semestre, 4) = v_ano
  ),
  -- Em 2024/2025 cada titulo pendente cai em UM submotivo: EM_CONFIRMACAO tem
  -- precedencia na propria regra das seis linhas (o teste de pago_sem_lastro
  -- exige situacao PAGO, que exclui EM_CONFIRMACAO).
  b as (
    select 'em_confirmacao' as motivo, aluno_id, titulo_id, vo as valor
      from t where sit = 'EM_CONFIRMACAO'
    union all
    select 'pago_sem_lastro', aluno_id, titulo_id, vo
      from t where sit = 'PAGO' and not tem_acordo and not liq_prime and pago_direto = 0
  ),
  linhas as (
    select motivo,
           count(distinct aluno_id)  as alunos,
           count(distinct titulo_id) as titulos,
           round(sum(valor), 2)      as valor
      from b group by motivo
  ),
  tot as (
    select count(distinct aluno_id)  as alunos,
           count(distinct titulo_id) as titulos,
           round(sum(valor), 2)      as valor
      from b
  )
  select jsonb_build_object(
    'recorte', v_ano, 'gerado_em', now(),
    'fonte', 'acordos_titulos + serie da Prime, ao vivo',
    'contagens_somaveis', true,
    'total', (select jsonb_build_object('alunos', alunos, 'titulos', titulos,
                                        'valor', coalesce(valor, 0)) from tot),
    'motivos', (select coalesce(jsonb_agg(jsonb_build_object(
                   'chave',   motivo,
                   'rotulo',  public.carteira_pendencia_rotulo(motivo),
                   'acao',    public.carteira_pendencia_acao(motivo),
                   'alunos',  alunos, 'titulos', titulos, 'valor', valor)
                   order by valor desc), '[]'::jsonb) from linhas),
    'conferencia', (select jsonb_build_object(
                   'total_valor',     coalesce(t.valor, 0),
                   'soma_das_linhas', coalesce((select round(sum(valor), 2) from linhas), 0),
                   'diferenca',       round(coalesce(t.valor, 0)
                                            - coalesce((select sum(valor) from linhas), 0), 2),
                   'fecha',           round(coalesce(t.valor, 0)
                                            - coalesce((select sum(valor) from linhas), 0), 2) = 0)
                   from tot t)
  ) into v_out;

  return v_out;
end;
$function$;

comment on function public.carteira_pendencias_por_motivo(text, text) is
  'Abre o total "Pendente de classificacao" pelos submotivos REAIS que '
  'carteira_safra_situacoes.pendente_detalhe ja publicava -- em_validacao, '
  'ajuste_academico e convertido_origem_comprovada em 2026/1; em_confirmacao e '
  'pago_sem_lastro em 2024/2025. Nenhum submotivo novo. Os valores sao disjuntos e '
  'somam `pendente` (`conferencia` mede a cada chamada); em 2026/1 as contagens de '
  'titulo e aluno NAO somam entre submotivos, e `contagens_somaveis` = false diz isso. '
  'Cada submotivo declara a acao que a regra existente permite. SO LEITURA.';

revoke all on function public.carteira_pendencias_por_motivo(text, text) from public, anon;
grant execute on function public.carteira_pendencias_por_motivo(text, text) to authenticated, service_role;


-- ===========================================================================
-- 3. O REGISTRO INDIVIDUAL -- a Fila Unica chega ao aluno/titulo
-- ===========================================================================
-- Toda pendencia exibida na Efetividade tem de ser alcancavel aqui. A funcao
-- devolve LINHAS, nao agregado: aluno, CPF, titulo, safra, valor, motivo,
-- situacao, evidencia, responsavel, data de entrada e a acao disponivel.
--
-- PAGINADA de proposito: a fila trata caso a caso e o universo de 2026/1 e
-- grande; `p_limite` tem teto rigido de 500 para nenhuma chamada de tela poder
-- pedir a base inteira e estourar o teto do papel `authenticated`.
create or replace function public.carteira_pendencias_itens(
  p_motivo   text,
  p_ano      text,
  p_semestre text default null,
  p_limite   integer default 100,
  p_offset   integer default 0
)
returns table (
  aluno_id          uuid,
  aluno_nome        text,
  cpf               text,
  titulo_id         uuid,
  documento         text,
  vencimento        date,
  safra             text,
  valor             numeric,
  motivo            text,
  motivo_rotulo     text,
  situacao_titulo   text,
  evidencia         text,
  responsavel_email text,
  desde             timestamptz,
  acao              text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_ano text := nullif(btrim(coalesce(p_ano, '')), '');
  v_sem text := nullif(btrim(coalesce(p_semestre, '')), '');
  v_mot text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_lim integer := least(greatest(coalesce(p_limite, 100), 1), 500);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if v_ano is null or v_mot is null then
    raise exception 'Informe o ano e o motivo.' using errcode = '22023';
  end if;

  if v_mot not in ('em_validacao', 'ajuste_academico', 'convertido_origem_comprovada',
                   'em_confirmacao', 'pago_sem_lastro') then
    raise exception 'Motivo desconhecido: %.', v_mot using errcode = '22023';
  end if;

  -- ------------------------------------------------------------------ 2026/1
  if v_ano = '2026' and v_sem = '1' then
    return query
    with c as (select * from public.carteira_2026_1_classificar()),
    f as (
      select c.aluno_id, c.titulo_id,
             case v_mot when 'em_validacao' then c.em_validacao
                        when 'ajuste_academico' then c.academico
                        when 'convertido_origem_comprovada' then c.ef_convertido
                        else 0 end as valor
        from c
    )
    select al.id, al.nome, al.cpf,
           t.id, t.documento, t.vencimento,
           '2026/1'::text,
           round(f.valor, 2),
           v_mot, public.carteira_pendencia_rotulo(v_mot),
           t.situacao,
           -- EVIDENCIA: o que se sabe, dito em uma linha. Nao e diagnostico
           -- nosso -- e o estado do registro, para a pessoa decidir.
           case v_mot
             when 'em_validacao' then
               'Classificado em validacao por carteira_2026_1_classificar(); saldo ainda nao recebido.'
             when 'ajuste_academico' then
               'Ajuste academico / cobranca encerrada administrativamente na classificacao da safra.'
             else
               'Conversao com origem comprovada: ha evidencia de conversao, sem definir se foi pagamento ou acordo.'
           end,
           coalesce(cs.operador_email, al.responsavel_atual_email),
           al.academico_atualizado_em,
           public.carteira_pendencia_acao(v_mot)
      from f
      join public.acordos_titulos t on t.id = f.titulo_id
      left join public.alunos al on al.id = f.aluno_id
      left join public.casos cs on cs.aluno_id = f.aluno_id
                               and not coalesce(cs.encerrado_operacional, false)
     where f.valor > 0
     order by f.valor desc, t.documento
     limit v_lim offset v_off;
    return;
  end if;

  -- --------------------------------------------------------------- 2024/2025
  if v_ano not in ('2024', '2025') then
    raise exception 'Safra sem regua definida: %. Use 2024, 2025 ou 2026/1.', v_ano
      using errcode = '22023';
  end if;

  if v_mot not in ('em_confirmacao', 'pago_sem_lastro') then
    raise exception 'Motivo % nao existe em %; use em_confirmacao ou pago_sem_lastro.', v_mot, v_ano
      using errcode = '22023';
  end if;

  return query
  with ts as (
    select regexp_replace(coalesce(boleto, ''), '\D', '', 'g') b, max(semestre) semestre
      from public.prime_titulo_semestre group by 1
  ),
  pag as (
    select regexp_replace(titulo_numero, '\D', '', 'g') b, sum(valor_pago) pago
      from public.pagamentos where coalesce(titulo_numero, '') <> '' group by 1
  ),
  t as (
    select t.id as titulo_id, t.aluno_id, t.valor_original vo, t.documento, t.vencimento,
           t.situacao, t.atualizado_em,
           upper(coalesce(t.situacao, '')) sit,
           (t.acordo_id is not null) tem_acordo,
           coalesce(pg.pago, 0) pago_direto,
           (t.origem_liquidacao is not null) liq_prime
      from public.acordos_titulos t
      left join ts on ts.b = regexp_replace(coalesce(t.documento, ''), '\D', '', 'g')
      left join pag pg on pg.b = regexp_replace(coalesce(t.documento, ''), '\D', '', 'g')
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and (t.tipo_boleto ilike 'Cursos de Gradua%' or t.tipo_boleto ilike 'Cursos de P%s Gradua%')
       and left(ts.semestre, 4) = v_ano
  )
  select al.id, al.nome, al.cpf,
         t.titulo_id, t.documento, t.vencimento,
         v_ano,
         round(t.vo, 2),
         v_mot, public.carteira_pendencia_rotulo(v_mot),
         t.situacao,
         case v_mot
           when 'em_confirmacao' then
             'Titulo em EM_CONFIRMACAO: ha pagamento ou liquidacao a conferir. Resolve-se pelo fluxo da Conferencia Prime.'
           else
             'Marcado PAGO sem lastro: sem acordo, sem pagamento casado pelo numero do titulo e sem origem_liquidacao. '
             || 'O unico vestigio e o campo de saldo estar abaixo do valor original, e esse campo nao e saldo atualizado.'
         end,
         coalesce(cs.operador_email, al.responsavel_atual_email),
         t.atualizado_em,
         public.carteira_pendencia_acao(v_mot)
    from t
    left join public.alunos al on al.id = t.aluno_id
    left join public.casos cs on cs.aluno_id = t.aluno_id
                             and not coalesce(cs.encerrado_operacional, false)
   where (v_mot = 'em_confirmacao' and t.sit = 'EM_CONFIRMACAO')
      or (v_mot = 'pago_sem_lastro' and t.sit = 'PAGO'
          and not t.tem_acordo and not t.liq_prime and t.pago_direto = 0)
   order by t.vo desc, t.documento
   limit v_lim offset v_off;
end;
$function$;

comment on function public.carteira_pendencias_itens(text, text, text, integer, integer) is
  'O registro individual de cada pendencia: aluno, CPF, titulo, safra, valor, motivo, '
  'situacao, evidencia, responsavel, data de entrada e acao disponivel. E o caminho da '
  'Efetividade (resumo) para a Fila Unica (tratamento). Mesmo universo de '
  'carteira_pendencias_por_motivo. Paginada, com teto rigido de 500 por chamada para '
  'nenhuma tela pedir a base inteira. SO LEITURA -- a resolucao e sempre pelas RPCs '
  'proprias de cada fluxo (Conferencia Prime), nunca por esta funcao.';

revoke all on function public.carteira_pendencias_itens(text, text, text, integer, integer) from public, anon;
grant execute on function public.carteira_pendencias_itens(text, text, text, integer, integer) to authenticated, service_role;
