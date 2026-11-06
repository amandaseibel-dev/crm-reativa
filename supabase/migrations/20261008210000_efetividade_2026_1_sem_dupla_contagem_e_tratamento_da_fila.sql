-- EFETIVIDADE + FILA UNICA -- fecha as duas frentes sobre o que JA esta em
-- producao, sem duplicar funcao, tabela ou migration.
--
-- Esta migration substitui a tentativa do PR #635, que foi fechado por ser
-- incompativel com os objetos aplicados em producao pelo #634/#642. Aqui nada
-- e reaberto: a REGUA HISTORICA OFICIAL de 2024/2025, a camada de fotografia,
-- o dreno, os crons e as RPCs da Conferencia Prime ficam como estao.
--
-- ===========================================================================
-- MEDIDO EM PRODUCAO (ahattpqrjmhkzsmnbdzs) EM 08/10/2026, SOMENTE LEITURA
-- ===========================================================================
-- Antes de escrever uma linha, o estado real:
--
--   crons ......... `carteira_efetividade_dreno` */5 e
--                   `carteira_efetividade_hora` */20, os dois ATIVOS
--   fotografia .... os 9 blocos (3 blocos x 3 recortes) existem, gerados
--                   20:20 UTC
--   gatilhos ...... 4 (pagamentos, parcelas, acordos, acordos_titulos)
--
-- Ou seja: "atualizacao automatica a cada 20 minutos" e "fotografia inicial"
-- JA ESTAVAM de pe. Esta migration nao os recria -- apenas DECLARA a cadencia
-- de 20 min no repositorio, que ainda dizia `40 * * * *`, e acrescenta os
-- gatilhos que faltavam. O resto e a divergencia de 2026/1 e o tratamento da
-- fila.
--
-- ===========================================================================
-- O QUE ESTA MIGRATION NAO FAZ
-- ===========================================================================
-- NAO altera saldo, acordo, pagamento, parcela ou titulo. A tabela nova guarda
-- APENAS a decisao humana sobre a pendencia; nenhum gatilho dela escreve em
-- tabela de dinheiro, e `carteira_pendencia_tratar` so faz um upsert nela mais
-- o pedido barato de reconstrucao da fotografia.
--
-- NAO toca `carteira_safra_situacoes`, `carteira_2026_1_classificar`,
-- `carteira_pendencias_por_motivo`, `carteira_saldo_historico_*`,
-- `carteira_academico_perfil_*`, `carteira_2026_2_*`, `carteira_efetividade_
-- recalcular`, `_recalcular_pendentes`, `_ler`, `_invalidar`, o fluxo
-- `EM_CONFIRMACAO` nem as RPCs da Conferencia Prime.
--
-- Reversivel: supabase/rollbacks/20261008210000_*.rollback.sql

begin;

-- ===========================================================================
-- 1. A FILA GANHA INICIO, ANALISE E ENCERRAMENTO
-- ===========================================================================
-- O defeito: a Fila Unica listava e resolvia, mas nao tinha ESTADO. Caso
-- analisado e caso nunca aberto eram indistinguiveis, "resolvido" vivia so na
-- memoria da aba (`resolvidos`, um Set no front) e sumia no F5, e nao havia
-- registro de quem encerrou, quando nem por que.
--
-- PENDENTE E A AUSENCIA DE LINHA. De proposito: nao ha o que semear, a fila
-- nasce inteira pendente e a tabela cresce so com o que foi tocado. Os 6.747
-- titulos em aberto de 2026/1 nao viram 6.747 linhas aqui.
--
-- UMA LINHA POR (titulo, motivo). O mesmo titulo pode ser pendente por motivos
-- diferentes e cada um se encerra por si -- e o que a fila ja mostra como
-- registros separados.
create table if not exists public.carteira_pendencia_tratamento (
  titulo_id      uuid        not null,
  motivo         text        not null,
  recorte        text        not null,
  estado         text        not null,
  desfecho       text,
  justificativa  text,
  -- Quem pegou o caso para analisar, e quem o encerrou. Separados porque nao e
  -- obrigatoriamente a mesma pessoa.
  analise_por    text,
  analise_em     timestamptz,
  finalizado_por text,
  finalizado_em  timestamptz,
  -- REABERTURA NAO APAGA O QUE HOUVE. Voltar um caso para analise mantem a
  -- linha e carimba aqui; sem isto um encerramento errado desapareceria sem
  -- deixar rastro, e o pedido era justamente manter o historico.
  reaberto_por   text,
  reaberto_em    timestamptz,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  constraint carteira_pendencia_tratamento_pk primary key (titulo_id, motivo),
  constraint carteira_pendencia_tratamento_estado_valido
    check (estado in ('EM_ANALISE', 'FINALIZADO')),
  constraint carteira_pendencia_tratamento_desfecho_valido
    check (desfecho is null or desfecho in ('VALIDADO_SEM_PENDENCIA', 'RESOLVIDO', 'REJEITADO')),
  -- FINALIZADO EXIGE DESFECHO. Encerrar sem dizer o que aconteceu produziria
  -- exatamente o buraco que esta frente existe para fechar.
  constraint carteira_pendencia_tratamento_finalizado_tem_desfecho
    check (estado <> 'FINALIZADO' or desfecho is not null),
  -- REJEITADO EXIGE JUSTIFICATIVA: e a unica decisao que declara a solicitacao
  -- indevida, e ela nao pode ficar sem motivo escrito.
  constraint carteira_pendencia_tratamento_rejeitado_tem_motivo
    check (desfecho is distinct from 'REJEITADO'
           or nullif(btrim(coalesce(justificativa, '')), '') is not null)
);

comment on table public.carteira_pendencia_tratamento is
  'Estado do tratamento de cada pendencia de validacao da Fila Unica: PENDENTE (ausencia '
  'de linha) -> EM_ANALISE -> FINALIZADO, com desfecho, justificativa, quem e quando. '
  'NAO guarda valor e NAO altera saldo, acordo, pagamento ou titulo: e o registro da '
  'decisao humana, nada mais. Escrita so por carteira_pendencia_tratar().';

comment on column public.carteira_pendencia_tratamento.desfecho is
  'VALIDADO_SEM_PENDENCIA = divida zerada e situacao conferida; RESOLVIDO = problema '
  'corrigido na origem; REJEITADO = solicitacao indevida, exige justificativa.';

-- Historico por safra/motivo e a consulta da aba de encerrados; sem indice ela
-- varreria a tabela inteira.
create index if not exists carteira_pendencia_tratamento_recorte_motivo_idx
  on public.carteira_pendencia_tratamento (recorte, motivo, estado);

-- Mesma protecao das outras tabelas desta area: privilegio amplo do schema
-- public inclui TRUNCATE, e RLS nao cobre TRUNCATE. A tela nunca toca a tabela
-- -- so as funcoes SECURITY DEFINER.
alter table public.carteira_pendencia_tratamento enable row level security;
revoke all on table public.carteira_pendencia_tratamento from public, anon, authenticated;
grant select, insert, update, delete on table public.carteira_pendencia_tratamento to service_role;


-- ===========================================================================
-- 2. A DECISAO -- a unica porta de escrita do tratamento
-- ===========================================================================
-- QUEM DECIDE: a mesma regra que a ficha do aluno e a Fila Unica ja aplicam
-- para decidir pendencia -- `usuario_e_gestao()`, que sao os tres e-mails de
-- `podeGerirFinanceiro` no front. Nao e regra nova nem papel novo.
--
-- O QUE ELA NAO FAZ: nao baixa titulo, nao zera saldo, nao cria nem cancela
-- acordo, nao lanca pagamento. "Validado, sem pendencias" e "Resolvido"
-- REGISTRAM uma conferencia que ja aconteceu na origem -- quem corrige o dado e
-- o fluxo oficial de cada tipo (a Conferencia Prime, no caso de
-- `em_confirmacao`). Encerrar aqui o que nao foi resolvido la seria mentir para
-- a proxima pessoa que abrir a fila.
create or replace function public.carteira_pendencia_tratar(
  p_titulo_id     uuid,
  p_motivo        text,
  p_recorte       text,
  p_estado        text,
  p_desfecho      text default null,
  p_justificativa text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  v_mot   text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_rec   text := nullif(btrim(coalesce(p_recorte, '')), '');
  v_est   text := upper(nullif(btrim(coalesce(p_estado, '')), ''));
  v_des   text := upper(nullif(btrim(coalesce(p_desfecho, '')), ''));
  v_jus   text := nullif(btrim(coalesce(p_justificativa, '')), '');
  v_quem  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_linha public.carteira_pendencia_tratamento;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Acesso negado: so a gestao financeira encerra pendencia de validacao.'
      using errcode = '42501';
  end if;

  if p_titulo_id is null or v_mot is null or v_rec is null or v_est is null then
    raise exception 'Informe titulo, motivo, recorte e estado.' using errcode = '22023';
  end if;

  -- O catalogo de motivos e o que `carteira_pendencias_itens` ja valida; repetir
  -- a lista aqui evita gravar tratamento para motivo que a fila nao conhece.
  if v_mot not in ('em_validacao', 'ajuste_academico', 'convertido_origem_comprovada',
                   'em_confirmacao', 'pago_sem_lastro') then
    raise exception 'Motivo desconhecido: %.', v_mot using errcode = '22023';
  end if;

  if v_rec not in ('2024', '2025', '2026/1') then
    raise exception 'Recorte desconhecido: %. Use 2024, 2025 ou 2026/1.', v_rec
      using errcode = '22023';
  end if;

  -- ------------------------------------------------------------- PENDENTE
  -- Voltar ao inicio e APAGAR a linha: pendente e a ausencia dela. Usado para
  -- desfazer um "em analise" aberto por engano. Nao serve para desfazer
  -- encerramento -- para isso existe a reabertura, que preserva o registro.
  if v_est = 'PENDENTE' then
    delete from public.carteira_pendencia_tratamento
     where titulo_id = p_titulo_id and motivo = v_mot and estado = 'EM_ANALISE';
    return jsonb_build_object('ok', true, 'estado', 'PENDENTE', 'titulo_id', p_titulo_id,
                              'motivo', v_mot, 'em', now());
  end if;

  if v_est not in ('EM_ANALISE', 'FINALIZADO') then
    raise exception 'Estado desconhecido: %. Use PENDENTE, EM_ANALISE ou FINALIZADO.', v_est
      using errcode = '22023';
  end if;

  if v_est = 'FINALIZADO' then
    if v_des is null then
      raise exception 'Para finalizar, informe o desfecho.' using errcode = '22023';
    end if;
    if v_des not in ('VALIDADO_SEM_PENDENCIA', 'RESOLVIDO', 'REJEITADO') then
      raise exception 'Desfecho desconhecido: %.', v_des using errcode = '22023';
    end if;
    if v_des = 'REJEITADO' and v_jus is null then
      raise exception 'Rejeitar exige justificativa: a solicitacao foi declarada indevida.'
        using errcode = '22023';
    end if;
  end if;

  -- ------------------------------------------------------------ EM_ANALISE
  if v_est = 'EM_ANALISE' then
    insert into public.carteira_pendencia_tratamento
           (titulo_id, motivo, recorte, estado, analise_por, analise_em, justificativa)
    values (p_titulo_id, v_mot, v_rec, 'EM_ANALISE', v_quem, now(), v_jus)
    on conflict (titulo_id, motivo) do update
       set estado        = 'EM_ANALISE',
           recorte       = excluded.recorte,
           -- Reabertura de caso ja encerrado: o desfecho sai, mas quem e quando
           -- encerrou FICAM, e a reabertura e carimbada.
           desfecho      = null,
           justificativa = coalesce(excluded.justificativa,
                                    public.carteira_pendencia_tratamento.justificativa),
           analise_por   = coalesce(public.carteira_pendencia_tratamento.analise_por, excluded.analise_por),
           analise_em    = coalesce(public.carteira_pendencia_tratamento.analise_em, excluded.analise_em),
           reaberto_por  = case when public.carteira_pendencia_tratamento.estado = 'FINALIZADO'
                                then v_quem else public.carteira_pendencia_tratamento.reaberto_por end,
           reaberto_em   = case when public.carteira_pendencia_tratamento.estado = 'FINALIZADO'
                                then now() else public.carteira_pendencia_tratamento.reaberto_em end,
           atualizado_em = now()
    returning * into v_linha;
  else
  -- ------------------------------------------------------------- FINALIZADO
    insert into public.carteira_pendencia_tratamento
           (titulo_id, motivo, recorte, estado, desfecho, justificativa,
            analise_por, analise_em, finalizado_por, finalizado_em)
    values (p_titulo_id, v_mot, v_rec, 'FINALIZADO', v_des, v_jus,
            v_quem, now(), v_quem, now())
    on conflict (titulo_id, motivo) do update
       set estado         = 'FINALIZADO',
           recorte        = excluded.recorte,
           desfecho       = excluded.desfecho,
           justificativa  = excluded.justificativa,
           analise_por    = coalesce(public.carteira_pendencia_tratamento.analise_por, excluded.analise_por),
           analise_em     = coalesce(public.carteira_pendencia_tratamento.analise_em, excluded.analise_em),
           finalizado_por = excluded.finalizado_por,
           finalizado_em  = excluded.finalizado_em,
           atualizado_em  = now()
    returning * into v_linha;

    -- A CONTAGEM POR MOTIVO VEM DA FOTOGRAFIA. Encerrar um caso tira a linha da
    -- fila na hora (a lista e lida ao vivo), mas o contador do motivo so
    -- acompanha na proxima reconstrucao. Marcar aqui e um upsert de tres linhas
    -- -- barato -- e o dreno de 5 em 5 min atende.
    perform public.carteira_efetividade_invalidar(
      'pendencia finalizada na Fila Unica', 'FILA_UNICA_FINALIZAR');
  end if;

  return jsonb_build_object(
    'ok', true,
    'titulo_id', v_linha.titulo_id,
    'motivo', v_linha.motivo,
    'estado', v_linha.estado,
    'desfecho', v_linha.desfecho,
    'justificativa', v_linha.justificativa,
    'finalizado_por', v_linha.finalizado_por,
    'finalizado_em', v_linha.finalizado_em,
    'reaberto_por', v_linha.reaberto_por,
    'reaberto_em', v_linha.reaberto_em,
    'em', now());
end;
$function$;

comment on function public.carteira_pendencia_tratar(uuid, text, text, text, text, text) is
  'Unica porta de escrita do tratamento de pendencia da Fila Unica: EM_ANALISE, '
  'FINALIZADO (com desfecho VALIDADO_SEM_PENDENCIA / RESOLVIDO / REJEITADO, este ultimo '
  'exigindo justificativa) e PENDENTE (desfaz "em analise"). Registra quem e quando. NAO '
  'altera saldo, acordo, pagamento, parcela ou titulo -- registra a decisao humana e pede '
  'a reconstrucao da fotografia. So a gestao financeira (usuario_e_gestao) escreve.';

revoke all on function public.carteira_pendencia_tratar(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.carteira_pendencia_tratar(uuid, text, text, text, text, text) to authenticated, service_role;


-- ===========================================================================
-- 3. A FILA ATIVA PASSA A EXCLUIR O QUE FOI ENCERRADO
-- ===========================================================================
-- `drop` + `create` porque a assinatura muda: entram um parametro
-- (`p_incluir_finalizados`) e cinco colunas de tratamento. O corpo e o MESMO
-- que esta em producao -- as duas reguas, as evidencias, o teto de 500, as
-- ordenacoes e os limites nao foram tocados. O que entra e um `left join` por
-- chave primaria na tabela do item 1 e um filtro.
--
-- O FILTRO ENTRA ANTES DO `limit`. Filtrar no front deixaria a pagina de 50
-- mostrando 43 e a paginacao mentindo -- e a doenca que esta area ja teve.
drop function if exists public.carteira_pendencias_itens(text, text, text, integer, integer);
create or replace function public.carteira_pendencias_itens(
  p_motivo   text,
  p_ano      text,
  p_semestre text default null,
  p_limite   integer default 100,
  p_offset   integer default 0,
  -- HISTORICO NA MESMA FUNCAO. `false` (padrao) e a FILA ATIVA: o caso
  -- finalizado sai dela. `true` e o HISTORICO: devolve os finalizados tambem,
  -- com quem finalizou, quando e por que. Uma funcao, dois recortes -- fila de
  -- historico em funcao separada duplicaria a consulta pesada.
  p_incluir_finalizados boolean default false
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
  -- O TRATAMENTO DO CASO. Nulo = PENDENTE (nunca tocado): a ausencia de linha
  -- E o primeiro estado, para nao precisar semear nada.
  tratamento_estado      text,
  tratamento_desfecho    text,
  tratamento_por         text,
  tratamento_em          timestamptz,
  tratamento_justificativa text
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
  v_inc boolean := coalesce(p_incluir_finalizados, false);
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
           public.carteira_pendencia_acao(v_mot),
           tr.estado, tr.desfecho, tr.finalizado_por, tr.finalizado_em, tr.justificativa
      from f
      join public.acordos_titulos t on t.id = f.titulo_id
      left join public.alunos al on al.id = f.aluno_id
      left join public.casos cs on cs.aluno_id = f.aluno_id
                               and not coalesce(cs.encerrado_operacional, false)
      -- Leitura por chave primaria da tabela de tratamento: nao acrescenta
      -- passada pesada nenhuma a esta consulta.
      left join public.carteira_pendencia_tratamento tr
             on tr.titulo_id = f.titulo_id and tr.motivo = v_mot
     where f.valor > 0
       and (v_inc or coalesce(tr.estado, '') <> 'FINALIZADO')
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
         public.carteira_pendencia_acao(v_mot),
         tr.estado, tr.desfecho, tr.finalizado_por, tr.finalizado_em, tr.justificativa
    from t
    left join public.alunos al on al.id = t.aluno_id
    left join public.casos cs on cs.aluno_id = t.aluno_id
                             and not coalesce(cs.encerrado_operacional, false)
    left join public.carteira_pendencia_tratamento tr
           on tr.titulo_id = t.titulo_id and tr.motivo = v_mot
   where (v_inc or coalesce(tr.estado, '') <> 'FINALIZADO')
     and ((v_mot = 'em_confirmacao' and t.sit = 'EM_CONFIRMACAO')
      or (v_mot = 'pago_sem_lastro' and t.sit = 'PAGO'
          and not t.tem_acordo and not t.liq_prime and t.pago_direto = 0))
   order by t.vo desc, t.documento
   limit v_lim offset v_off;
end;
$function$;

comment on function public.carteira_pendencias_itens(text, text, text, integer, integer, boolean) is
  'O registro individual de cada pendencia: aluno, CPF, titulo, safra, valor, motivo, '
  'situacao, evidencia, responsavel, data de entrada, acao disponivel e o TRATAMENTO '
  '(PENDENTE quando nao ha linha, EM_ANALISE, ou FINALIZADO com desfecho, quem e quando). '
  'Por padrao devolve a FILA ATIVA -- o finalizado sai dela, antes do limit, para a '
  'paginacao continuar verdadeira. `p_incluir_finalizados => true` devolve o historico. '
  'SO LEITURA: nao altera saldo, acordo, pagamento nem titulo.';

revoke all on function public.carteira_pendencias_itens(text, text, text, integer, integer, boolean) from public, anon;
grant execute on function public.carteira_pendencias_itens(text, text, text, integer, integer, boolean) to authenticated, service_role;


-- ===========================================================================
-- 4. A LEITURA DA FILA -- repassa o tratamento e desconta o total
-- ===========================================================================
-- `total_no_motivo` vem do bloco agregado fotografado. Encerrado um caso, a
-- fotografia ainda nao foi reconstruida; sem o desconto a tela diria "Casos
-- 1-43 de 1.043" com 43 na pagina e o contador velho. O desconto e um
-- `count(*)` por indice na tabela de tratamento -- barato, e mantem lista e
-- contador coerentes ANTES da proxima reconstrucao.
drop function if exists public.carteira_pendencias_itens_ler(text, text, text, integer, integer);

create or replace function public.carteira_pendencias_itens_ler(
  p_motivo   text,
  p_ano      text,
  p_semestre text default null,
  p_limite   integer default 50,
  p_offset   integer default 0,
  p_incluir_finalizados boolean default false
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
  tratamento_estado        text,
  tratamento_desfecho      text,
  tratamento_por           text,
  tratamento_em            timestamptz,
  tratamento_justificativa text,
  gerado_em         timestamptz,
  total_no_motivo   bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_total      bigint;
  v_recorte    text := case when p_ano = '2026'
                            then p_ano || '/' || coalesce(p_semestre, '1') else p_ano end;
  v_finalizados bigint;
  v_inc        boolean := coalesce(p_incluir_finalizados, false);
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
     and s.recorte = v_recorte
     and m->>'chave' = p_motivo;

  select count(*) into v_finalizados
    from public.carteira_pendencia_tratamento
   where recorte = v_recorte and motivo = p_motivo and estado = 'FINALIZADO';

  return query
  select i.aluno_id, i.aluno_nome, i.cpf, i.titulo_id, i.documento, i.vencimento, i.safra,
         i.valor, i.motivo, i.motivo_rotulo, i.situacao_titulo, i.evidencia,
         i.responsavel_email, i.desde, i.acao,
         i.tratamento_estado, i.tratamento_desfecho, i.tratamento_por,
         i.tratamento_em, i.tratamento_justificativa,
         now()::timestamptz as gerado_em,
         -- Historico: o total e o proprio numero de encerrados. Fila ativa: o
         -- total fotografado menos os que sairam por encerramento.
         case when v_inc then v_finalizados
              else greatest(coalesce(v_total, 0) - coalesce(v_finalizados, 0), 0) end as total_no_motivo
    from public.carteira_pendencias_itens(p_motivo, p_ano, p_semestre, p_limite, p_offset, v_inc) i;
end;
$function$;

comment on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer, boolean) is
  'Lista individual das pendencias, AO VIVO: delega para carteira_pendencias_itens e '
  'repassa o estado do tratamento. Por padrao e a FILA ATIVA (encerrado fora) e '
  '`total_no_motivo` e o total fotografado MENOS os encerrados, para lista e contador nao '
  'divergirem antes da proxima reconstrucao. `p_incluir_finalizados => true` devolve o '
  'historico, e ai o total e o numero de encerrados.';

revoke all on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer, boolean) from public, anon;
grant execute on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer, boolean) to authenticated, service_role;


-- ===========================================================================
-- 5. 2026/1 PARA DE CONTAR `em_validacao` DUAS VEZES
-- ===========================================================================
-- Ver o comentario dentro da propria funcao, com os numeros medidos. Unica
-- mudanca: o universo do aberto de 2026/1. A REGUA HISTORICA OFICIAL de
-- 2024/2025 (`portador = 195`, m166 sem acordo ativo, confirmacao pendente,
-- caso cancelado/juridico, liquidado na Prime apos vencimento+30, aluno coberto
-- por pagamentos desde 01/07/2026, alunos por count(distinct cpf), titulos por
-- count(*), valor por sum(saldo)) NAO e tocada -- esta reproduzida abaixo
-- VERBATIM, porque `create or replace` exige o corpo inteiro.
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
  -- O UNIVERSO DEIXA DE SOMAR `em_validacao`. Era a divergencia desta tela:
  -- `em_validacao` aparecia DUAS vezes na mesma pagina -- dentro da composicao
  -- do saldo em aberto E inteiro na linha "Pendente" das seis linhas, por
  -- `carteira_pendencias_por_motivo`. Medido em producao em 08/10/2026, lendo a
  -- fotografia das 20:20 UTC:
  --
  --   composicao (inadimplencia + em_validacao) . R$ 9.853.364,68 / 2.510 al / 7.790 tit
  --   linha "Em aberto" das seis linhas .......... R$ 9.116.096,81 / 2.086 al / 6.747 tit
  --   diferenca ................................. R$   737.267,87
  --   balde `em_validacao` das pendencias ....... R$   737.267,87 / 1.043 tit
  --
  -- A diferenca E o balde, ao centavo. Conferido na mesma medicao que so
  -- `inadimplencia` fecha com a linha oficial em 0,00 no valor, 0 nos titulos E
  -- 0 nos alunos. (Em 07/10/2026 o mesmo balde media R$ 805.704,28: ele se move
  -- com o dado, o defeito era a dupla contagem, nao o numero.)
  --
  -- `em_validacao` NAO SAI DA TELA e nao e descartado: segue inteiro em
  -- "Pendente", publicado por `carteira_pendencias_por_motivo`, que esta
  -- migration nao toca. O que sai e a duplicidade.
  if v_ano = '2026' and v_sem = '1' then
    with c as (select * from public.carteira_2026_1_classificar()),
    abertos as (
      select c.aluno_id, c.titulo_id, c.inadimplencia as valor
        from c
       where c.inadimplencia > 0
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
      'universo_em_aberto', 'inadimplencia (= balde "em aberto" das seis linhas)',
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
  '2026/1 o universo e `inadimplencia`, identico ao balde "em aberto" das seis linhas da '
  'mesma tela: `em_validacao` SAIU daqui em 08/10/2026 porque aparecia duas vezes na '
  'mesma pagina (R$ 737.267,87 medidos), e segue inteiro na linha "Pendente". Fecha em '
  'valor, titulos E alunos por construcao, e `conferencia` mede as tres a cada chamada. '
  'SO LEITURA.';

revoke all on function public.carteira_em_aberto_por_status_academico(text, text) from public, anon;
grant execute on function public.carteira_em_aberto_por_status_academico(text, text) to authenticated, service_role;


-- ===========================================================================
-- 6. OS DOIS GATILHOS QUE FALTAVAM -- e so eles
-- ===========================================================================
-- Producao tem 4 (pagamentos, parcelas, acordos, acordos_titulos), medido hoje.
-- Faltavam as duas tabelas que a REGUA HISTORICA le e que ninguem marcava:
--
--   acordo_titulo_vinculo ................... decide `negociado` na regua, e
--     titulo negociado SAI do aberto. Vincular um titulo a acordo muda o saldo
--     oficial e, sem este gatilho, a fotografia so acompanhava na rede de 20 min.
--   solicitacoes_confirmacao_pagamento ...... a CTE `conf` tira do aberto todo
--     aluno com confirmacao AGUARDANDO_CONFIRMACAO. E exatamente o universo que
--     a Fila Unica trata: resolver um caso mexe aqui.
--
-- Gatilho de STATEMENT, nao de linha, e a funcao engole a propria falha -- a
-- mesma `tg_carteira_efetividade_invalidar` que os outros 4 usam, sem nenhuma
-- funcao nova. Trabalho por linha em tabela quente derrubou o banco em
-- 24/09/2026; nao se repete aqui.
drop trigger if exists trg_efetividade_invalidar_vinculo on public.acordo_titulo_vinculo;
create trigger trg_efetividade_invalidar_vinculo
  after insert or update or delete on public.acordo_titulo_vinculo
  for each statement execute function public.tg_carteira_efetividade_invalidar();

drop trigger if exists trg_efetividade_invalidar_confirmacao on public.solicitacoes_confirmacao_pagamento;
create trigger trg_efetividade_invalidar_confirmacao
  after insert or update or delete on public.solicitacoes_confirmacao_pagamento
  for each statement execute function public.tg_carteira_efetividade_invalidar();


-- ===========================================================================
-- 7. A CADENCIA DE 20 MINUTOS PASSA A ESTAR DECLARADA NO REPOSITORIO
-- ===========================================================================
-- Producao ja roda `carteira_efetividade_hora` em `*/20` (medido hoje, ativo).
-- O repositorio ainda dizia `40 * * * *`: quem lesse o arquivo erraria a
-- cadencia, e um ambiente novo nasceria horario. `cron.schedule` com jobname
-- existente ATUALIZA o agendamento, nao cria um segundo job -- em producao esta
-- linha e um no-op que confirma o que ja esta la.
select cron.schedule('carteira_efetividade_hora', '*/20 * * * *',
                     $cron$select public.carteira_efetividade_recalcular();$cron$);

-- O dreno por evento continua de 5 em 5 min: ele atende o que os gatilhos
-- marcaram, e e o que faz o botao "Atualizar dados" e o encerramento de um caso
-- sairem antes da rede de 20 min.
select cron.schedule('carteira_efetividade_dreno', '*/5 * * * *',
                     $cron$select public.carteira_efetividade_recalcular_pendentes();$cron$);


-- ===========================================================================
-- 8. O QUE O BOTAO PROMETE PASSA A SER O QUE O CRON FAZ
-- ===========================================================================
-- `previsao` dizia "de 5 em 5 minutos" e a tela dizia "a rotina das :40". A
-- rede agora e de 20 min e o dreno e de 5. Unica mudanca nesta funcao: o texto.
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
    'previsao', 'a reconstrucao sai no proximo dreno (de 5 em 5 minutos); a rede automatica e de 20 em 20',
    'sincrono', false);
end;
$function$;

comment on function public.carteira_efetividade_solicitar_atualizacao() is
  'Registra pedido de reconstrucao da Efetividade e volta na hora. NAO executa a '
  'consulta pesada: quem reconstroi e o dreno (*/5), com a rede de 20 em 20 minutos.';

revoke all on function public.carteira_efetividade_solicitar_atualizacao() from public, anon;
grant execute on function public.carteira_efetividade_solicitar_atualizacao() to authenticated, service_role;

commit;
