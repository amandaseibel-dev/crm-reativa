-- ROLLBACK de 20261008210000_efetividade_2026_1_sem_dupla_contagem_e_tratamento_da_fila.sql
--
-- O QUE ESTE ROLLBACK FAZ, NESTA ORDEM:
--   1. derruba os 2 gatilhos novos (acordo_titulo_vinculo e
--      solicitacoes_confirmacao_pagamento);
--   2. restaura as 4 funcoes nas definicoes que estavam em producao antes
--      (carteira_pendencias_itens, _itens_ler, carteira_em_aberto_por_status_
--      academico e carteira_efetividade_solicitar_atualizacao);
--   3. derruba carteira_pendencia_tratar e, por ultimo, a tabela
--      carteira_pendencia_tratamento.
--
-- ATENCAO -- PERDA DE DADO NO PASSO 3. `carteira_pendencia_tratamento` guarda
-- quem analisou e quem encerrou cada pendencia, com motivo e data. Derrubar a
-- tabela APAGA esse historico, e ele nao existe em nenhum outro lugar: as
-- decisoes de "Validado, sem pendencias" e "Rejeitado" vivem SO aqui (as de
-- "Resolvido" tambem estao na auditoria da Conferencia Prime, porque la a
-- correcao e feita na origem). Antes de derrubar, exporte:
--     create table carteira_pendencia_tratamento_backup_20261008 as
--       select * from public.carteira_pendencia_tratamento;
-- O passo 3 esta comentado no fim deste arquivo exatamente por isso --
-- descomente so depois do backup.
--
-- ATENCAO 2 -- O DEFEITO VOLTA. Restaurar `carteira_em_aberto_por_status_
-- academico` reintroduz a DUPLA CONTAGEM de `em_validacao` em 2026/1: a
-- composicao volta a R$ 9.853.364,68 contra a linha "Em aberto" de
-- R$ 9.116.096,81, divergencia de R$ 737.267,87 (medido em 08/10/2026).
--
-- CRON NAO E TOCADO AQUI. `carteira_efetividade_hora` ja estava em `*/20` em
-- producao ANTES desta migration (medido em 08/10/2026); a migration so passou
-- a declarar isso no repositorio. Reverter para `40 * * * *` nao restauraria
-- nada -- restauraria um estado que nao existia.
--
-- NAO TOCADO por esta migration e portanto sem reversao:
--   carteira_safra_situacoes, carteira_2026_1_classificar,
--   carteira_pendencias_por_motivo, carteira_saldo_historico_*,
--   carteira_academico_perfil_*, carteira_2026_2_*,
--   carteira_efetividade_recalcular, _recalcular_pendentes, _ler, _invalidar,
--   tg_carteira_efetividade_invalidar, os 4 gatilhos anteriores, as tabelas de
--   fotografia e de invalidacao, o fluxo EM_CONFIRMACAO e as RPCs da
--   Conferencia Prime.

begin;

-- ---------------------------------------------------------------------------
-- 1. os 2 gatilhos novos saem
-- ---------------------------------------------------------------------------
drop trigger if exists trg_efetividade_invalidar_vinculo on public.acordo_titulo_vinculo;
drop trigger if exists trg_efetividade_invalidar_confirmacao on public.solicitacoes_confirmacao_pagamento;

-- ---------------------------------------------------------------------------
-- 2a. carteira_pendencias_itens volta a assinatura de 5 parametros
-- ---------------------------------------------------------------------------
drop function if exists public.carteira_pendencias_itens(text, text, text, integer, integer, boolean);
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

revoke all on function public.carteira_pendencias_itens(text, text, text, integer, integer) from public, anon;
grant execute on function public.carteira_pendencias_itens(text, text, text, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2b. carteira_pendencias_itens_ler volta a 17 colunas
-- ---------------------------------------------------------------------------
drop function if exists public.carteira_pendencias_itens_ler(text, text, text, integer, integer, boolean);
create or replace function public.carteira_pendencias_itens_ler(
  p_motivo   text,
  p_ano      text,
  p_semestre text default null,
  p_limite   integer default 50,
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
  acao              text,
  gerado_em         timestamptz,
  total_no_motivo   bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_total bigint;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  -- O total do motivo sai do bloco agregado, que ja esta fotografado -- leitura
  -- por chave primaria, barata. Sem fotografia ainda, devolve nulo e a fila
  -- pagina pelo tamanho da pagina.
  select (m->>'titulos')::bigint into v_total
    from public.carteira_efetividade_snapshot s,
         lateral jsonb_array_elements(coalesce(s.payload->'motivos','[]'::jsonb)) m
   where s.bloco = 'pendencias_por_motivo'
     and s.recorte = case when p_ano = '2026'
                          then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end
     and m->>'chave' = p_motivo;

  return query
  select i.aluno_id, i.aluno_nome, i.cpf, i.titulo_id, i.documento, i.vencimento, i.safra,
         i.valor, i.motivo, i.motivo_rotulo, i.situacao_titulo, i.evidencia,
         i.responsavel_email, i.desde, i.acao,
         now()::timestamptz as gerado_em,
         v_total as total_no_motivo
    from public.carteira_pendencias_itens(p_motivo, p_ano, p_semestre, p_limite, p_offset) i;
end;
$function$;

comment on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) is
  'Lista individual das pendencias, AO VIVO: delega para carteira_pendencias_itens. A '
  'Fila Unica trata caso a caso, e trabalhar sobre fotografia ofereceria para tratamento '
  'um caso que talvez ja esteja resolvido. Mesma assinatura de retorno de quando lia '
  'fotografia, para o front nao mudar; `gerado_em` e o instante da leitura e '
  '`total_no_motivo` vem do bloco agregado, nao da pagina.';

revoke all on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) from public, anon;
grant execute on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2c. a composicao volta a somar em_validacao em 2026/1 (o defeito volta)
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

  -- ------------------------------------------------------------------ 2026/1
  -- Inalterado: em 2026/1 o universo oficial do aberto JA e inadimplencia +
  -- em validacao, pela regra da safra, e a composicao ja fechava 0,00 em valor,
  -- 0 em titulos e 0 em alunos (medido em producao em 07/10/2026).
  if v_ano = '2026' and v_sem = '1' then
    with c as (select * from public.carteira_2026_1_classificar()),
    abertos as (
      select c.aluno_id, c.titulo_id, (c.inadimplencia + c.em_validacao) as valor
        from c
       where c.inadimplencia + c.em_validacao > 0
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
      'recorte',  '2026/1',
      'natureza', 'CARTEIRA_CONSOLIDADA',
      'fonte',    'carteira_2026_1_classificar() ao vivo',
      'universo_em_aberto', 'inadimplencia + em_validacao',
      'regua', 'classificacao da safra 2026/1',
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
                    'titulos_soma',     coalesce((select sum(titulos) from linhas), 0),
                    'alunos_total',     t.alunos,
                    'alunos_soma',      coalesce((select sum(alunos) from linhas), 0))
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

  -- REGUA HISTORICA OFICIAL -- copia verbatim de carteira_saldo_historico_recalcular().
  with pag_titulo as materialized (
    select distinct titulo_numero b from public.pagamentos where coalesce(titulo_numero,'') <> ''
  ),
  m166 as materialized (
    select distinct lpad(regexp_replace(cpf, '\D', '', 'g'), 11, '0') cpf
      from public.prime_portador_membro where portador = 166
  ),
  acordo_ativo as materialized (
    select distinct aluno_id from public.acordos where status = 'ATIVO' and aluno_id is not null
  ),
  conf as materialized (
    select distinct aluno_id from public.solicitacoes_confirmacao_pagamento
     where status = 'AGUARDANDO_CONFIRMACAO'
  ),
  caso_fora as materialized (
    select distinct aluno_id from public.casos
     where public.normalizar_status_acionamento(coalesce(status_atual, status_acionamento, status_jornada))
           = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'])
  ),
  pago_julho as materialized (
    select aluno_id, sum(valor_pago) pago from public.pagamentos
     where data_pagamento >= date '2026-07-01' and aluno_id is not null group by 1
  ),
  t as materialized (
    select t.id, t.aluno_id,
           lpad(regexp_replace(coalesce(nullif(t.cpf,''), al.cpf, ''), '\D', '', 'g'), 11, '0') cpf,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo,
           t.situacao, t.status, t.vencimento, t.origem_liquidacao, t.acordo_id,
           ts.semestre, left(ts.semestre, 4) ano,
           case when ex.boleto is null then ts.carrier_id
                when ts.boleto is null or ex.coletado_em >= ts.coletado_em then ex.portador
                else ts.carrier_id end portador,
           case when ex.boleto is null then ts.liquidado_em
                when ts.boleto is null or ex.coletado_em >= ts.coletado_em then ex.liquidado_em
                else ts.liquidado_em end liq,
           (t.acordo_id is not null
            or exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id)) negociado,
           exists (select 1 from public.parcelas p where p.boleto = t.documento) eh_boleto_de_parcela,
           (pg.b is not null) tem_pagamento_no_titulo
      from public.acordos_titulos t
      left join public.alunos al on al.id = t.aluno_id
      left join lateral (select s.semestre, s.carrier_id, s.liquidado_em, s.coletado_em, s.boleto
                           from public.prime_titulo_semestre s where s.boleto = t.documento limit 1) ts on true
      left join lateral (select e.portador, e.liquidado_em, e.coletado_em, e.boleto
                           from public.prime_extrato e where e.boleto = t.documento limit 1) ex on true
      left join pag_titulo pg on pg.b = t.documento
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and (t.tipo_boleto ilike 'Cursos de Gradua%' or t.tipo_boleto ilike 'Cursos de P%s Gradua%')
  ),
  cand as materialized (
    select *, sum(saldo) over (partition by aluno_id) devido_total
      from t
     where upper(coalesce(situacao,'')) = 'ABERTO'
       and lower(coalesce(status,'')) = 'em_aberto'
       and not negociado
       and acordo_id is null
       and not eh_boleto_de_parcela
       and not tem_pagamento_no_titulo
       and origem_liquidacao is null
       and saldo > 0
       and portador = 195
       and not coalesce(liq > vencimento + 30, false)
       and (semestre in ('2024/1','2024/2','2025/1','2025/2') or semestre is null)
  ),
  aberto as materialized (
    select c.*
      from cand c
      left join m166 m on m.cpf = c.cpf
      left join acordo_ativo aa on aa.aluno_id = c.aluno_id
      left join conf cf on cf.aluno_id = c.aluno_id::text
      left join caso_fora cx on cx.aluno_id = c.aluno_id
      left join pago_julho pj on pj.aluno_id = c.aluno_id
     where not ((m.cpf is not null and aa.aluno_id is null)
                or cf.aluno_id is not null
                or cx.aluno_id is not null
                or coalesce(pj.pago, 0) >= c.devido_total)
  ),
  -- Recorte do ano pedido. `ano is not null` e da funcao oficial: titulo sem
  -- serie da Prime nao entra em ano nenhum (ele vive no bloco `sem_semestre`).
  ano_pedido as (
    select * from aberto where ano = v_ano and ano is not null
  ),
  -- UM status por CPF, deterministico. Ver o cabecalho: medido ZERO CPF com
  -- mais de uma situacao, e ainda assim resolvido por CPF para a invariante ser
  -- por construcao.
  cpf_status as (
    select a.cpf,
           min(coalesce(nullif(btrim(al.situacao_academica), ''), '(sem situação importada)')) as status
      from ano_pedido a
      left join public.alunos al on al.id = a.aluno_id
     group by a.cpf
  ),
  linhas as (
    select s.status,
           count(distinct a.cpf)  as alunos,
           count(*)               as titulos,
           round(sum(a.saldo), 2) as valor
      from ano_pedido a
      join cpf_status s on s.cpf = a.cpf
     group by s.status
  ),
  tot as (
    select count(distinct cpf)  as alunos,
           count(*)             as titulos,
           round(sum(saldo), 2) as valor
      from ano_pedido
  ),
  fonte as (
    select max(al.academico_atualizado_em) as atualizado_em
      from (select distinct aluno_id from ano_pedido) u
      join public.alunos al on al.id = u.aluno_id
  )
  select jsonb_build_object(
    'recorte',  v_ano,
    'natureza', 'COBERTURA_HISTORICA',
    'fonte',    'mesma regua de carteira_saldo_historico_por_ano().aberto, ao vivo',
    'universo_em_aberto', 'saldo em aberto atual (regua historica oficial)',
    'regua', 'carteira_saldo_historico_por_ano().aberto',
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
                                           - coalesce((select sum(valor) from linhas), 0), 2) = 0
                                     and t.titulos = coalesce((select sum(titulos) from linhas), 0)
                                     and t.alunos  = coalesce((select sum(alunos) from linhas), 0),
                  'titulos_total',   t.titulos,
                  'titulos_soma',    coalesce((select sum(titulos) from linhas), 0),
                  'alunos_total',    t.alunos,
                  'alunos_soma',     coalesce((select sum(alunos) from linhas), 0))
                  from tot t),
    'fonte_academica', (select jsonb_build_object(
                  'importacao_atualizada_em', atualizado_em) from fonte)
  ) into v_out;

  return v_out;
end;
$function$;

comment on function public.carteira_em_aberto_por_status_academico(text, text) is
  'Decomposicao do SALDO EM ABERTO ATUAL por situacao academica real. Em 2024/2025 o '
  'universo e a regua historica oficial -- copia verbatim das CTEs de '
  'carteira_saldo_historico_recalcular(), com alunos por count(distinct cpf), titulos '
  'por count(*) e valor por sum(saldo) -- e NAO o balde em_aberto das seis linhas, que '
  'e regua mais ampla (R$ 4,99 mi contra R$ 3,67 mi em 2024, medido em 07/10/2026). Em '
  '2026/1 segue sendo inadimplencia + em_validacao. Fecha em valor, titulos E alunos '
  'por construcao, e `conferencia` mede as tres a cada chamada. SO LEITURA.';

revoke all on function public.carteira_em_aberto_por_status_academico(text, text) from public, anon;
grant execute on function public.carteira_em_aberto_por_status_academico(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2d. o texto do botao volta a prometer so o dreno
-- ---------------------------------------------------------------------------
create or replace function public.carteira_efetividade_solicitar_atualizacao()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  perform public.carteira_efetividade_invalidar('pedido da tela', 'BOTAO_ATUALIZAR');

  return jsonb_build_object(
    'ok', true,
    'solicitado_em', now(),
    'previsao', 'a reconstrucao sai no proximo dreno (de 5 em 5 minutos)',
    'sincrono', false);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. a porta de escrita do tratamento sai
-- ---------------------------------------------------------------------------
drop function if exists public.carteira_pendencia_tratar(uuid, text, text, text, text, text);

-- A TABELA SO SAI DEPOIS DO BACKUP -- ver o aviso no cabecalho.
-- drop table if exists public.carteira_pendencia_tratamento;

commit;
