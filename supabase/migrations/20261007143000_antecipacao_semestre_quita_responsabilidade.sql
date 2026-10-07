-- ANTECIPACAO DE SEMESTRE: o saldo do aluno sai da conta e a parcela que estava
-- sob a NOSSA responsabilidade e quitada.
--
-- Pedido da gestao em 07/10/2026. A tabulacao `ANTECIPACAO_SEMESTRE` ja existe
-- desde 10/09/2026 (migration 20260910173223_tabulacoes_alegacao), mas so como
-- ALEGACAO: bloqueava acionamento, agendava 20 dias uteis e encaminhava a Amanda
-- ADM para apurar com a unidade. Medido em 07/10/2026: **0 alunos** tabulados
-- com ela -- nenhuma ficha existente muda de comportamento por causa desta
-- migration, e nenhum fluxo em uso e interrompido.
--
-- O QUE A ANTECIPACAO E, NO DINHEIRO. O aluno antecipou o semestre direto com a
-- unidade. Duas consequencias, e elas sao de naturezas DIFERENTES:
--
--   1. o SALDO DO ALUNO deixa de contabilizar. Nao foi pago a nos: saiu da base
--      por decisao administrativa da unidade. Entao o titulo sai como
--      `CANCELADA` + `origem_encerramento`, exatamente como o encerramento
--      administrativo da Conferencia Prime (19/09/2026) -- e NAO como `PAGO`,
--      que afirmaria recuperacao nossa.
--   2. a PARCELA SOB NOSSA RESPONSABILIDADE e quitada. Essa e a parcela do
--      acordo que nos negociamos: ela sai de aberto, com `origem_baixa` propria,
--      e `honorarios` INTOCADO.
--
-- O QUE ESTA MIGRATION NAO FAZ, DE PROPOSITO:
--   * nao insere em `pagamentos` nem em `baixas_pagamento` -- nao entrou
--     dinheiro no caixa do Santander, e inventar um credito para "fechar" a
--     baixa seria gravar chute como fato;
--   * nao escreve `parcelas.honorarios` -- a decisao da gestao em 07/10/2026 foi
--     "so baixa operacional", sem receita. Quem quiser excluir ou isolar estas
--     linhas em relatorio tem o filtro pronto: `parcelas.origem_baixa =
--     'ANTECIPACAO_SEMESTRE'` e `acordos_titulos.origem_encerramento =
--     'ANTECIPACAO_SEMESTRE'`;
--   * nao reescreve `recalcular_situacao_aluno`. A funcao tem 13.696 bytes em
--     producao e a copia do repositorio esta atras dela (ver
--     supabase/ledger/DUAS-TRILHAS.md). Reescrever por arquivo antigo apagaria
--     mudanca que so existe no banco. O eixo de efetividade/honorario fica como
--     esta, e a antecipacao fica RASTREAVEL para quem precisar separa-la depois;
--   * nao toca nos titulos NEGOCIADO vinculados a acordo vivo. Quando a ultima
--     parcela e quitada, `_acordo_fecha_com_a_ultima_parcela` fecha o acordo e
--     `titulos_por_status_acordo` -> `titulo_reavaliar` decide o destino deles
--     com `origem_liquidacao = 'ACORDO_QUITADO'`. Essa maquina ja existe e esta
--     testada; duplica-la aqui criaria duas verdades para o mesmo titulo.
--
-- POR QUE A TABULACAO VIRA SOMENTE GESTAO. Ela passou a mover dinheiro. Um
-- operador escolhendo um item de `<select>` nao pode quitar parcela. A trava e
-- dupla e nenhuma das duas e silenciosa:
--   * `tabulacoes.somente_gestao = true` (governanca no catalogo);
--   * `_encerramento_so_gestao` passa a listar `ANTECIPACAO_SEMESTRE` junto de
--     cancelamento/suspensao/juridico: o operador recebe mensagem dizendo a quem
--     pedir, no lugar de uma tabulacao que "funciona pela metade".
-- O front hoje nao le `somente_gestao` (ver src/utils/tabulacoes.js), entao a
-- opcao continua aparecendo no select e o banco recusa -- e exatamente o que
-- `CANCELAMENTO_COBRANCA` ja faz hoje.
--
-- ROLLBACK: supabase/rollbacks/20261007143000_antecipacao_semestre_quita_responsabilidade.rollback.sql

-- ---------------------------------------------------------------------------
-- 1. VOCABULARIO: as duas origens novas
-- ---------------------------------------------------------------------------
-- Sem isto o UPDATE da baixa e do encerramento abortaria pelo CHECK. Os valores
-- antigos continuam todos validos: a lista so cresce.
alter table public.parcelas drop constraint if exists parcelas_origem_baixa_valida;
alter table public.parcelas add constraint parcelas_origem_baixa_valida
  check (origem_baixa is null or origem_baixa = any (array[
    'OPERADOR','ADM','GATILHO_IMPORTACAO','BAIXA_RELATORIO','IMPORTACAO_ACORDO',
    'AUTOMACAO','ANTECIPACAO_SEMESTRE']));

alter table public.acordos_titulos drop constraint if exists acordos_titulos_origem_encerramento_valida;
alter table public.acordos_titulos add constraint acordos_titulos_origem_encerramento_valida
  check (origem_encerramento is null or origem_encerramento = any (array[
    'CONFERENCIA_PRIME_ADMINISTRATIVA','ANTECIPACAO_SEMESTRE']));

-- ---------------------------------------------------------------------------
-- 2. CATALOGO: o desfecho fica no catalogo, nao no gatilho
-- ---------------------------------------------------------------------------
-- `efeito_desfecho` existe para que o gatilho pergunte ao catalogo "esta
-- tabulacao tem desfecho?" em vez de carregar o codigo escrito na mao. E a mesma
-- razao de `redireciona_para_email` (10/09/2026): mudar a regra da tabulacao nao
-- pode exigir mexer em funcao.
alter table public.tabulacoes
  add column if not exists efeito_desfecho text;

alter table public.tabulacoes drop constraint if exists tabulacoes_efeito_desfecho_valido;
alter table public.tabulacoes add constraint tabulacoes_efeito_desfecho_valido
  check (efeito_desfecho is null or efeito_desfecho = any (array['ANTECIPACAO_SEMESTRE']));

comment on column public.tabulacoes.efeito_desfecho is
  'Desfecho que o ato de tabular aplica. ANTECIPACAO_SEMESTRE = encerra o saldo do aluno administrativamente e quita a parcela sob nossa responsabilidade. Nulo = tabulacao sem efeito financeiro.';

-- A tabulacao deixa de ser alegacao a apurar e passa a ser desfecho:
--   * sem retorno (nao ha o que cobrar da unidade -- quem tabula ja tem a
--     confirmacao dela na mao);
--   * sem redirecionamento (nao vai mais para a ADM apurar);
--   * `bloqueia_acionamento` mantido: ninguem cobra quem antecipou.
update public.tabulacoes
   set grupo = 'ENCERRAMENTO',
       retorno_modo = 'NENHUM',
       retorno_dias_uteis = null,
       proxima_acao = 'CONTATAR',
       bloqueia_acionamento = true,
       somente_gestao = true,
       redireciona_para_email = null,
       efeito_desfecho = 'ANTECIPACAO_SEMESTRE',
       atualizado_por = 'gestao 07/10/2026',
       atualizado_em = now()
 where codigo = 'ANTECIPACAO_SEMESTRE';

-- ---------------------------------------------------------------------------
-- 3. AUDITORIA
-- ---------------------------------------------------------------------------
-- Dinheiro sai de aberto sem credito no extrato. Sem a linha de auditoria,
-- "por que esta parcela esta paga?" nao tem resposta por consulta.
create table if not exists public.antecipacao_semestre_auditoria (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid not null,
  motivo text not null,
  parcelas_quitadas_qtd int not null default 0,
  parcelas_quitadas_valor numeric not null default 0,
  titulos_encerrados_qtd int not null default 0,
  titulos_encerrados_valor numeric not null default 0,
  saldo_antes numeric,
  saldo_depois numeric,
  status_anterior text,
  executado_por text,
  executado_em timestamptz not null default now()
);
alter table public.antecipacao_semestre_auditoria enable row level security;
drop policy if exists antecipacao_semestre_auditoria_ro on public.antecipacao_semestre_auditoria;
create policy antecipacao_semestre_auditoria_ro
  on public.antecipacao_semestre_auditoria for select
  using (coalesce(auth.role(),'') = 'service_role' or public.usuario_e_gestao());

create index if not exists idx_antecipacao_semestre_auditoria_aluno
  on public.antecipacao_semestre_auditoria(aluno_id, executado_em desc);

comment on table public.antecipacao_semestre_auditoria is
  'Uma linha por aplicacao de antecipacao de semestre: quanto saiu de parcela, quanto saiu de titulo, saldo antes e depois, e quem decidiu. Nenhum pagamento foi criado em nenhuma delas.';

-- ---------------------------------------------------------------------------
-- 4. O MOTOR
-- ---------------------------------------------------------------------------
create or replace function public.antecipacao_semestre_aplicar(
  p_aluno_id uuid,
  p_motivo text,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email    text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_sistema  boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_nome     text;
  v_st_ant   text;
  v_saldo_antes  jsonb;
  v_saldo_depois jsonb;
  v_parc_qtd int := 0;     v_parc_val numeric := 0;
  v_tit_qtd  int := 0;     v_tit_val  numeric := 0;
  v_ref      text;
begin
  if p_aluno_id is null then
    raise exception 'aluno_id nulo.' using errcode = '22023';
  end if;

  -- Mesma trinca de `confirmar_saldo_zero_retirar_filas`: Amanda, Fernanda,
  -- Amanda ADM. `usuario_e_gestao()` e a fonte unica dessa lista.
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Antecipação de semestre é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;

  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatório: a antecipação precisa dizer qual unidade confirmou e quando.'
      using errcode = '22023';
  end if;

  select nome,
         coalesce(status_jornada, status_atual, '(sem status)')
    into v_nome, v_st_ant
    from public.alunos
   where id = p_aluno_id;

  if v_nome is null and not exists (select 1 from public.alunos where id = p_aluno_id) then
    raise exception 'Aluno % não existe.', p_aluno_id using errcode = '22023';
  end if;

  v_saldo_antes := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);
  v_ref := 'antecipacao_semestre:' || p_aluno_id::text;

  -- DRY RUN: devolve exatamente o que SERIA escrito, pelas mesmas clausulas do
  -- UPDATE. Nenhuma escrita, nenhum gatilho.
  if p_dry_run then
    select count(*), coalesce(sum(coalesce(p.valor,0)),0)
      into v_parc_qtd, v_parc_val
      from public.parcelas p
      join public.acordos a on a.id = p.acordo_id
     where a.aluno_id = p_aluno_id
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

    select count(*), coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)),0)
      into v_tit_qtd, v_tit_val
      from public.acordos_titulos t
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and coalesce(lower(t.status),'') not in ('quitada')
       and t.origem_encerramento is null
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'aluno_id', p_aluno_id,
      'parcelas_a_quitar_qtd', v_parc_qtd, 'parcelas_a_quitar_valor', round(v_parc_val,2),
      'titulos_a_encerrar_qtd', v_tit_qtd, 'titulos_a_encerrar_valor', round(v_tit_val,2),
      'saldo_antes', (v_saldo_antes->>'total')::numeric);
  end if;

  -- REENTRANCIA. O bloco (c) escreve `alunos.status_jornada`, que e exatamente
  -- o evento de `trg_tabulacao_antecipacao_semestre`. Sem esta marca o gatilho
  -- chamaria este motor de novo, em recursao. E local a transacao (terceiro
  -- argumento `true`), como `conferencia_prime.decisao`, e por isso fica DEPOIS
  -- do dry-run: uma previa nao pode travar a aplicacao real da mesma transacao.
  perform set_config('antecipacao_semestre.aplicando', 'on', true);

  -- (a) A PARCELA SOB NOSSA RESPONSABILIDADE. `honorarios` fica como esta: a
  -- baixa e operacional, nao e receita. `confirmado_por_email` registra quem
  -- decidiu, nao quem recebeu -- porque ninguem recebeu.
  with q as (
    update public.parcelas p
       set status = 'PAGO',
           pago_em = now(),
           confirmado_por_email = coalesce(nullif(v_email,''), 'antecipacao_semestre'),
           origem_baixa = 'ANTECIPACAO_SEMESTRE',
           origem_baixa_ref = v_ref,
           origem_baixa_em = now(),
           observacao = coalesce(p.observacao,'')
             || case when coalesce(p.observacao,'') = '' then '' else ' | ' end
             || 'quitada por antecipação de semestre em ' || to_char(now(),'DD/MM/YYYY')
             || ' por ' || coalesce(nullif(v_email,''),'gestão')
             || ': ' || btrim(p_motivo)
             || '. Sem pagamento no extrato e sem honorário -- baixa operacional.',
           atualizado_em = now()
     where p.acordo_id in (
             select a.id from public.acordos a
              where a.aluno_id = p_aluno_id
                and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
       and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
    returning coalesce(p.valor,0) as valor)
  select count(*), coalesce(sum(valor),0) into v_parc_qtd, v_parc_val from q;

  -- (b) O SALDO DO ALUNO. Mesmo predicado de `aluno_saldo_pendente_detalhe`:
  -- so sai o que de fato CONTABILIZA hoje. Titulo coberto por acordo vivo nao
  -- entra aqui -- quem decide o destino dele e `titulo_reavaliar`, depois que o
  -- acordo fecha com a ultima parcela de (a).
  with e as (
    update public.acordos_titulos t
       set situacao = 'CANCELADA',
           status   = 'cancelada',
           origem_encerramento     = 'ANTECIPACAO_SEMESTRE',
           origem_encerramento_ref = v_ref,
           origem_encerramento_em  = now(),
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'encerrado administrativamente por antecipação de semestre em '
             || to_char(now(),'DD/MM/YYYY') || ' por ' || coalesce(nullif(v_email,''),'gestão')
             || ': ' || btrim(p_motivo)
             || '. Não foi pago a nós: saiu da base pela unidade. Sem pagamento, acordo ou recuperação.',
           atualizado_em = now()
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and coalesce(lower(t.status),'') not in ('quitada')
       and t.origem_encerramento is null
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
    returning coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor)
  select count(*), coalesce(sum(valor),0) into v_tit_qtd, v_tit_val from e;

  -- (c) O MARCADOR OPERACIONAL, por ultimo e de proposito. As escritas de (a) e
  -- (b) disparam `_talvez_quitar_aluno` e o recalculo, que escrevem em `alunos`
  -- e `casos`. Marcar antes seria marcar para ser sobrescrito.
  --
  -- `quitado_em`/`origem_quitacao` saem nulos: nao houve quitacao nossa. Esse e
  -- o ponto em que a antecipacao se distingue de QUITADO para sempre.
  update public.alunos
     set status_atual = 'ANTECIPACAO_SEMESTRE',
         status_jornada = 'ANTECIPACAO_SEMESTRE',
         status_acionamento = 'ANTECIPACAO_SEMESTRE',
         situacao_operacional = 'ANTECIPACAO_SEMESTRE',
         valor_em_aberto = 0,
         fila_destino = null,
         proxima_acao = null,
         data_retorno = null,
         hora_retorno = null
   where id = p_aluno_id;

  update public.casos
     set status_atual = 'ANTECIPACAO_SEMESTRE',
         status_jornada = 'ANTECIPACAO_SEMESTRE',
         status_acionamento = 'ANTECIPACAO_SEMESTRE',
         status_financeiro = 'ANTECIPACAO_SEMESTRE',
         situacao_operacional = 'ANTECIPACAO_SEMESTRE',
         total_em_aberto = 0,
         nao_acionar = true,
         quitado_em = null,
         origem_quitacao = null,
         data_retorno = null,
         proxima_acao_automatica = null,
         caso_atualizado_por = coalesce(nullif(v_email,''), 'antecipacao_semestre'),
         caso_atualizado_em = now()
   where aluno_id = p_aluno_id;

  v_saldo_depois := public.aluno_saldo_pendente_detalhe(p_aluno_id, null);

  insert into public.antecipacao_semestre_auditoria
    (aluno_id, motivo, parcelas_quitadas_qtd, parcelas_quitadas_valor,
     titulos_encerrados_qtd, titulos_encerrados_valor, saldo_antes, saldo_depois,
     status_anterior, executado_por)
  values (p_aluno_id, btrim(p_motivo), v_parc_qtd, round(v_parc_val,2),
          v_tit_qtd, round(v_tit_val,2),
          (v_saldo_antes->>'total')::numeric, (v_saldo_depois->>'total')::numeric,
          v_st_ant, coalesce(nullif(v_email,''), 'antecipacao_semestre'));

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (p_aluno_id::text, 'ANTECIPACAO_SEMESTRE',
    'Antecipação de semestre aplicada: ' || v_parc_qtd || ' parcela(s) sob nossa responsabilidade quitada(s) ('
      || public.fmt_brl(round(v_parc_val,2)) || ') e ' || v_tit_qtd
      || ' título(s) do aluno encerrado(s) administrativamente ('
      || public.fmt_brl(round(v_tit_val,2)) || '), que deixam de contabilizar no saldo. '
      || 'Nenhum pagamento e nenhum honorário foram criados. Motivo: ' || btrim(p_motivo),
    v_st_ant, 'ANTECIPACAO_SEMESTRE',
    coalesce(v_nome, nullif(v_email,''), 'gestão'), coalesce(nullif(v_email,''),'sistema'), now(),
    round(v_parc_val + v_tit_val, 2));

  return jsonb_build_object(
    'ok', true, 'dry_run', false, 'aluno_id', p_aluno_id,
    'status', 'ANTECIPACAO_SEMESTRE',
    'parcelas_quitadas_qtd', v_parc_qtd, 'parcelas_quitadas_valor', round(v_parc_val,2),
    'titulos_encerrados_qtd', v_tit_qtd, 'titulos_encerrados_valor', round(v_tit_val,2),
    'saldo_antes', (v_saldo_antes->>'total')::numeric,
    'saldo_depois', (v_saldo_depois->>'total')::numeric);
end;
$function$;

comment on function public.antecipacao_semestre_aplicar(uuid, text, boolean) is
  'Aplica a antecipacao de semestre: encerra administrativamente os titulos que contabilizam saldo (origem_encerramento = ANTECIPACAO_SEMESTRE, situacao CANCELADA) e quita as parcelas sob nossa responsabilidade (origem_baixa = ANTECIPACAO_SEMESTRE). NAO cria pagamento, NAO escreve honorario e NAO marca quitado_em. Somente gestao. p_dry_run = true (padrao) nao escreve nada.';

revoke all on function public.antecipacao_semestre_aplicar(uuid, text, boolean) from public, anon;
grant execute on function public.antecipacao_semestre_aplicar(uuid, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. TABULAR APLICA -- o gatilho
-- ---------------------------------------------------------------------------
-- A tabulacao e gravada em `alunos.status_jornada` por mais de um caminho
-- (carteira, ficha, modal). A regra fica no gatilho pela mesma razao que a de
-- redirecionamento (10/09/2026): repeti-la em cada tela seria esquece-la na
-- proxima.
--
-- O nome comeca com `trg_tabulacao_antecipacao` para disparar ANTES de
-- `trg_tabulacao_redireciona` (gatilhos de mesmo evento disparam em ordem
-- alfabetica) -- nao que importe, porque a antecipacao limpa
-- `redireciona_para_email`, mas a ordem fica deterministica.
create or replace function public.trg_tabulacao_antecipacao_semestre()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_efeito text;
begin
  -- O motor esta rodando nesta transacao e foi ele que escreveu este
  -- status_jornada. Entrar aqui de novo seria recursao.
  if coalesce(current_setting('antecipacao_semestre.aplicando', true), '') = 'on' then
    return new;
  end if;

  if new.status_jornada is not distinct from old.status_jornada then
    return new;
  end if;

  select t.efeito_desfecho into v_efeito
    from public.tabulacoes t
   where t.codigo = new.status_jornada and t.ativa and t.efeito_desfecho is not null;

  if coalesce(v_efeito,'') <> 'ANTECIPACAO_SEMESTRE' then
    return new;
  end if;

  perform public.antecipacao_semestre_aplicar(
    new.id,
    'tabulação "Antecipação de semestre" registrada na ficha',
    false);

  return new;
end;
$$;

comment on function public.trg_tabulacao_antecipacao_semestre() is
  'Ao tabular uma tabulacao com efeito_desfecho = ANTECIPACAO_SEMESTRE, aplica o desfecho (encerra o saldo e quita a parcela nossa). Quem nao e gestao nunca chega aqui: _encerramento_so_gestao recusa a tabulacao antes.';

drop trigger if exists trg_tabulacao_antecipacao_semestre on public.alunos;
create trigger trg_tabulacao_antecipacao_semestre
  after update of status_jornada on public.alunos
  for each row execute function public.trg_tabulacao_antecipacao_semestre();

-- ---------------------------------------------------------------------------
-- 6. AS TRES FUNCOES QUE PASSAM A CONHECER O CODIGO
-- ---------------------------------------------------------------------------
-- Texto base das tres = PRODUCAO lida em 07/10/2026, nao a copia do repositorio
-- (ver supabase/ledger/DUAS-TRILHAS.md). Cada uma muda UMA linha, marcada.

-- 6.1 Operador nao tabula antecipacao: a mensagem diz a quem pedir.
create or replace function public._encerramento_so_gestao()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  -- + ANTECIPACAO_SEMESTRE (07/10/2026): passou a quitar parcela, virou decisao
  --   de gestao como cancelamento, suspensao e juridico.
  v_encerra text[] := array['CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','JURIDICO','ANTECIPACAO_SEMESTRE'];
  v_novo text[];
  v_antigo text[];
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role'
                       or auth.jwt() is null
                       or session_user in ('postgres','reativa_responsavel_executor');
begin
  if v_sistema or coalesce(public.usuario_e_gestao(), false) then
    return new;
  end if;

  v_novo := array[upper(coalesce(new.status_atual,'')), upper(coalesce(new.status_jornada,'')),
                  upper(coalesce(new.status_acionamento,''))];
  v_antigo := array[upper(coalesce(old.status_atual,'')), upper(coalesce(old.status_jornada,'')),
                    upper(coalesce(old.status_acionamento,''))];

  -- So barra quando o encerramento e NOVO: reescrever o que ja estava la nao e
  -- o operador encerrando nada.
  if (v_novo && v_encerra) and not (v_antigo && v_encerra) then
    raise exception
      'Encerrar cobrança (cancelamento, suspensão, jurídico ou antecipação de semestre) é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

-- 6.2 O caso sai da contagem dos 500 e das filas -- mas SO quando o saldo de
--     titulo aberto e zero, como ja vale para PAGO/QUITADO. Se sobrou titulo
--     aberto, o caso fica na fila: o marcador nao mente sobre a divida.
create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text,
  p_status_financeiro text, p_status_jornada text)
returns boolean
language plpgsql stable set search_path to 'public'
as $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- status_acionamento fala do ACIONAMENTO. 'CANCELADO' aqui e acordo
  -- cancelado, nao cobranca cancelada -- e nao tira ninguem da fila.
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- + ANTECIPACAO SEMESTRE (07/10/2026). Entra pelo ramo condicional de propo-
  -- sito: `normalizar_status_acionamento` troca '_' por ' ', por isso sem under-
  -- score aqui.
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- 6.3 A quitacao automatica nao apaga o marcador da antecipacao. Sem esta
--     linha, `_trg_auto_quitar_parcela` -> `_talvez_quitar_aluno` reescreveria
--     `status_jornada` para 'QUITADO' e carimbaria `origem_quitacao =
--     QUITACAO_AUTOMATICA` -- afirmando uma quitacao nossa que nao houve.
create or replace function public._talvez_quitar_aluno(v_aluno uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_saldo numeric; v_parc int; v_conf int;
begin
  if v_aluno is null then return; end if;

  -- Titulo aguardando a Conferencia Prime nao e divida quitada: o aluno
  -- espera a decisao, nao vira QUITADO.
  if exists (select 1 from public.acordos_titulos
              where aluno_id = v_aluno and upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') then
    return;
  end if;

  select coalesce(sum(coalesce(saldo_corrigido, valor_original, 0)), 0) into v_saldo
    from public.acordos_titulos
   where aluno_id = v_aluno and upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO');
  if v_saldo > 0 then return; end if;

  select count(*) into v_parc
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = v_aluno
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  if v_parc > 0 then return; end if;

  select count(*) into v_conf
    from public.solicitacoes_confirmacao_pagamento
   where aluno_id = v_aluno::text and status = 'AGUARDANDO_CONFIRMACAO';
  if v_conf > 0 then return; end if;

  update public.alunos
    set status_jornada = 'QUITADO', status_atual = 'QUITADO', status_acionamento = 'QUITADO',
        valor_em_aberto = 0
    where id = v_aluno
      -- + ANTECIPACAO_SEMESTRE (07/10/2026)
      and coalesce(status_jornada,'') not in ('QUITADO','QUITADO_MANUAL','JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','ANTECIPACAO_SEMESTRE');

  update public.casos
     set status_financeiro = 'QUITADO_AUTOMATICO',
         quitado_em        = current_date,
         origem_quitacao   = 'QUITACAO_AUTOMATICA',
         total_em_aberto   = 0,
         criticidade       = 'NORMAL',
         caso_atualizado_por = 'sistema_quitacao_automatica',
         caso_atualizado_em  = now()
   where aluno_id = v_aluno
     and quitado_em is null
     and operador_email is not null
     -- + ANTECIPACAO_SEMESTRE (07/10/2026): le do ALUNO, nao do caso. No caminho
     --   do gatilho o aluno ja esta marcado quando a parcela e quitada; o caso
     --   ainda nao. Ler do caso deixaria a guarda sem efeito justamente ali.
     and not exists (select 1 from public.alunos al
                      where al.id = v_aluno
                        and coalesce(al.status_jornada,'') = 'ANTECIPACAO_SEMESTRE');
end;
$function$;
