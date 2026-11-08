-- ============================================================================
-- ULBRA — ETAPA 1: RECEBIMENTO (RESPOSTAS E NOVOS ATENDIMENTOS) DENTRO DO CRM
--
-- Artefato de 08/11/2026. NAO APLICAR SEM AUTORIZACAO EXPLICITA DA GESTAO.
-- NAO FOI APLICADO EM NENHUM AMBIENTE. Nada aqui rodou.
--
-- O QUE ISTO INSTALA
--   1. `ulbra_conversas`     espelho das conversas da equipe Reativa (sem contador)
--   1b. `ulbra_leitura_usuario` leitura por usuario: uma linha por pessoa e conversa
--   2. `ulbra_atendimentos`  fila dos atendimentos em espera da equipe Reativa
--   3. `ulbra_sync_estado`   cursor, contador de chamadas do dia, ultimo erro
--   4. `ulbra_sync_gravar`   unica porta de escrita; so service_role
--   5. `ulbra_atendimento_assumir`   posse por UPDATE condicional
--   6. `ulbra_atendimento_dispensar` devolve o lead a fila, com motivo
--   7. `ulbra_conversa_marcar_lida`  marca leitura POR USUARIO (ulbra_leitura_usuario)
--
-- O QUE ISTO NAO FAZ
--   - nao altera `casos`, `alunos`, `fila_receptivo`, `ulbra_vinculos`,
--     `whatsapp_*` nem qualquer objeto existente;
--   - nao cria cron. O cron entra depois, em passo proprio, quando a funcao
--     `ulbra-sincronizar` estiver publicada e a chave estiver no Vault (ver
--     "DEPOIS DESTE SQL", no fim do arquivo). Memoria
--     `publicar-funcao-de-cron-dispara-na-hora`: cron e deploy na mesma janela
--     disparam junto, e aqui isso seria consumo de orcamento sem ninguem
--     olhando;
--   - nao escreve nada de identidade por conta propria: `aluno_id` so chega
--     por `ulbra_vinculos` com `confianca = 'alta_cpf'`, decidido na funcao.
--
-- GRANTS, PELA REGRA DA CASA
--   Tabela nova herda TRUNCATE para `authenticated` (memoria
--   `tabela-nova-herda-truncate-para-authenticated`). Os REVOKE abaixo sao
--   explicitos e vem ANTES dos GRANT. `authenticated` fica so com SELECT; toda
--   escrita passa por funcao SECURITY DEFINER com `search_path` fixo.
-- ============================================================================

begin;

-- ---------------------------------------------------------------- conversas
create table public.ulbra_conversas (
  ulbra_conversa_id      text primary key,
  ulbra_cliente_id       text not null,
  cliente_nome           text,
  canal                  text not null default 'whatsapp',
  situacao               text not null,
  equipe                 text not null,
  responsavel_ulbra      text,
  ultima_mensagem_em     timestamptz,
  ultima_mensagem_quem   text,
  ultima_mensagem_previa text,
  -- Data da ultima mensagem RECEBIDA DO CLIENTE. Nao e contador: "nao lida"
  -- e uma pergunta por usuario (ver ulbra_leitura_usuario), e o banco so
  -- guarda o fato que todos compartilham.
  ultima_mensagem_cliente_em timestamptz,
  aluno_id               uuid references public.alunos (id),
  aluno_status           text not null default 'nao_confirmado',
  criado_em              timestamptz not null default now(),
  atualizado_em          timestamptz not null default now(),
  constraint ulbra_conversas_equipe_check check (equipe = 'Reativa'),
  constraint ulbra_conversas_aluno_status_check
    check (aluno_status in ('vinculado', 'nao_confirmado'))
);

comment on table public.ulbra_conversas is
  'Espelho das conversas da equipe Reativa na Mensageria ULBRA. Escrita so por ulbra_sync_gravar. O CHECK de equipe e estrutural: conversa de outra equipe nao entra nem por engano de codigo.';
comment on column public.ulbra_conversas.aluno_status is
  'vinculado = ulbra_vinculos ativo com confianca alta_cpf. nao_confirmado = vai para conferencia; nunca se resolve por nome ou telefone.';

create index ulbra_conversas_cliente_idx on public.ulbra_conversas (ulbra_cliente_id);
create index ulbra_conversas_aluno_idx on public.ulbra_conversas (aluno_id)
  where aluno_id is not null;
create index ulbra_conversas_recentes_idx on public.ulbra_conversas (ultima_mensagem_em desc);

-- ------------------------------------------------------------ atendimentos
create table public.ulbra_atendimentos (
  ulbra_atendimento_id text primary key,
  ulbra_cliente_id     text not null,
  cliente_nome         text,
  equipe               text not null,
  situacao             text not null,
  coluna               text,
  entrou_em            timestamptz,
  aluno_id             uuid references public.alunos (id),
  aluno_status         text not null default 'nao_confirmado',
  destino_email        text,
  destino_motivo       text not null,
  responsavel_email    text,
  assumido_em          timestamptz,
  dispensado_em        timestamptz,
  dispensado_por       text,
  dispensa_motivo      text,
  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now(),
  constraint ulbra_atendimentos_equipe_check check (equipe = 'Reativa'),
  constraint ulbra_atendimentos_aluno_status_check
    check (aluno_status in ('vinculado', 'nao_confirmado')),
  constraint ulbra_atendimentos_destino_motivo_check
    check (destino_motivo in ('CARTEIRA', 'RODIZIO', 'CONFERENCIA', 'SEM_OPERADOR'))
);

comment on table public.ulbra_atendimentos is
  'Fila dos atendimentos em espera da equipe Reativa. destino_email e SUGESTAO; a posse nasce de ulbra_atendimento_assumir, que e UPDATE condicional -- dois operadores nao conseguem assumir o mesmo.';
comment on column public.ulbra_atendimentos.destino_motivo is
  'CARTEIRA = aluno ja tem dono (preserva carteira e fidelizacao). RODIZIO = sugerido ao proximo do receptivo online. CONFERENCIA = identidade nao confirmada, ninguem recebe. SEM_OPERADOR = ninguem online no momento da leitura.';

create index ulbra_atendimentos_destino_idx on public.ulbra_atendimentos (destino_email)
  where responsavel_email is null and dispensado_em is null;
create index ulbra_atendimentos_abertos_idx on public.ulbra_atendimentos (entrou_em desc)
  where dispensado_em is null;

-- ------------------------------------------------------------------ estado
create table public.ulbra_sync_estado (
  id                        boolean primary key default true,
  cursor_mensagem           timestamptz,
  -- janela do backlog: piso do que ja foi processado num ciclo incompleto, e
  -- a mensagem mais nova ja processada. Ver sincronizar.ts (novaJanela).
  piso_pendente             timestamptz,
  topo_processado           timestamptz,
  -- fila de detalhes: quantas conversas ficaram sem leitura de detalhe, e quantas
  -- foram desistidas apos o maximo de tentativas (perda declarada, visivel).
  detalhe_fila_tamanho      integer not null default 0,
  -- pendencias abertas: conversas esgotadas, preservadas para recuperacao.
  detalhes_pendencias_abertas integer not null default 0,
  alerta_gestao             text,
  -- saldo DIARIO da pessoa do token, lido de meu_acesso.limites.pessoaPorDia.restam
  saldo_api_restam          integer,
  saldo_api_em              timestamptz,
  ultima_execucao           timestamptz,
  ultimo_ciclo              text,
  ultimo_erro               text,
  chamadas_dia              integer not null default 0,
  dia                       date not null default current_date,
  ciclos_desde_atendimentos integer not null default 999,
  constraint ulbra_sync_estado_linha_unica check (id)
);

-- Fila de detalhes: conversas cuja ultima mensagem NAO e do cliente. Uma linha
-- por conversa (dedupe pela chave). Sai com a leitura de detalhe ou desistida.
create table public.ulbra_detalhe_fila (
  ulbra_conversa_id text primary key references public.ulbra_conversas (ulbra_conversa_id) on delete cascade,
  ulbra_cliente_id  text not null,
  na_lista_em       timestamptz not null,
  tentativas        integer not null default 0,
  antes_de          text,
  paginas_lidas     integer not null default 0,
  enfileirado_em    timestamptz not null default now(),
  constraint ulbra_detalhe_tentativas_check check (tentativas >= 0)
);
-- Pendencias: conversas esgotadas (5 falhas). NAO sao descartadas: ficam aqui
-- ate a gestao reabrir. Sao o registro da perda possivel, nunca silencio.
create table public.ulbra_detalhe_pendencias (
  ulbra_conversa_id text primary key references public.ulbra_conversas (ulbra_conversa_id) on delete cascade,
  ulbra_cliente_id  text not null,
  na_lista_em       timestamptz not null,
  motivo            text not null default 'FALHAS_ESGOTADAS',
  criada_em         timestamptz not null default now(),
  recuperada_em     timestamptz,
  recuperada_por    text,
  antes_de          text
);
comment on table public.ulbra_detalhe_pendencias is
  'Conversas sem leitura de detalhe apos o maximo de tentativas. Aberta ate a gestao reabrir. Visivel so para a gestao.';

create index ulbra_detalhe_fila_ordem_idx on public.ulbra_detalhe_fila (na_lista_em);

comment on table public.ulbra_detalhe_fila is
  'Conversas aguardando leitura de detalhe (ler_conversa). Escrita so por ulbra_sync_gravar.';

comment on table public.ulbra_sync_estado is
  'Uma linha. Cursor do incremental e medidor do orcamento diario da Mensageria (teto medido: 500 chamadas/dia por pessoa). chamadas_dia zera na virada de `dia`.';

insert into public.ulbra_sync_estado (id) values (true);

-- ------------------------------------------------------- leitura por usuario
-- Uma linha por (usuario, conversa): ate quando AQUELE usuario leu. A gestao
-- NAO le a linha de outro usuario -- marcador de leitura individual nao serve
-- a operacao e nao deve ser exposto. "Nao lida" para X = a conversa tem
-- mensagem do cliente mais nova que o lido_ate de X (ou nunca foi lida por X).
create table public.ulbra_leitura_usuario (
  usuario_email    text not null,
  ulbra_conversa_id text not null references public.ulbra_conversas (ulbra_conversa_id) on delete cascade,
  lido_ate         timestamptz not null,
  atualizado_em    timestamptz not null default now(),
  primary key (usuario_email, ulbra_conversa_id),
  constraint ulbra_leitura_email_minusculo check (usuario_email = lower(usuario_email))
);

comment on table public.ulbra_leitura_usuario is
  'Leitura por usuario. Cada pessoa ve e escreve SO a propria linha (RLS). Gestao nao le a de terceiros.';

-- --------------------------------------------------------------- RLS e grants
alter table public.ulbra_conversas enable row level security;
alter table public.ulbra_atendimentos enable row level security;
alter table public.ulbra_sync_estado enable row level security;
alter table public.ulbra_detalhe_fila enable row level security;
alter table public.ulbra_detalhe_pendencias enable row level security;
create policy ulbra_detalhe_pendencias_gestao on public.ulbra_detalhe_pendencias
  for select to authenticated using (usuario_e_gestao() and not eh_painel());
revoke all on public.ulbra_detalhe_pendencias from authenticated, anon, public;
grant select on public.ulbra_detalhe_pendencias to authenticated;
revoke all on public.ulbra_detalhe_fila from authenticated, anon, public;

-- LEITURA. A regra e aplicada no banco -- senao qualquer usuario ativo leria o
-- espelho inteiro por SQL, e a separacao existiria so no front. O painel da TV
-- e barrado, como nas demais.
--
-- PILOTO DE OBSERVACAO (autorizado em 08/11/2026): SO A GESTAO LE.
--
-- A sincronizacao CONTINUA gravando `destino_email` e `destino_motivo`: e assim
-- que o piloto mede o que o rodizio TERIA decidido, sem que a sugestao chegue a
-- operador nenhum. Os campos existem, sao preenchidos e ninguem fora da gestao
-- os ve.
--
-- Por que o ramo de operador tinha de sair, e nao bastava esvaziar a fila do
-- rodizio: `decidirDestino` marca `CARTEIRA` sempre que o aluno tem caso com
-- operador, ANTES de consultar o rodizio (sincronizar.ts). Com a fila vazia o
-- caminho CARTEIRA continua valendo, e o operador continuaria vendo.
--
-- A regra de regime -- gestao ve tudo; operador ve a conversa dos alunos que
-- sao casos dele e o atendimento sugerido a ele ou por ele assumido -- esta
-- provada em `08_regime_pos_piloto.sql`, que a aplica e reexecuta as
-- afirmacoes. E esse arquivo que descreve a migration de fim de piloto.
create policy ulbra_conversas_leitura on public.ulbra_conversas
  for select to authenticated using (
    not eh_painel() and app_usuario_ativo() and usuario_e_gestao()
  );
create policy ulbra_atendimentos_leitura on public.ulbra_atendimentos
  for select to authenticated using (
    not eh_painel() and app_usuario_ativo() and usuario_e_gestao()
  );
-- Estado do ciclo e diagnostico: so gestao.
create policy ulbra_sync_estado_leitura on public.ulbra_sync_estado
  for select to authenticated using (usuario_e_gestao() and not eh_painel());

alter table public.ulbra_leitura_usuario enable row level security;
create policy ulbra_leitura_usuario_propria on public.ulbra_leitura_usuario
  for all to authenticated
  using (usuario_email = lower(coalesce(app_email(), '')) and app_usuario_ativo() and not eh_painel())
  with check (usuario_email = lower(coalesce(app_email(), '')) and app_usuario_ativo() and not eh_painel());
revoke all on public.ulbra_leitura_usuario from authenticated, anon, public;
grant select, insert, update on public.ulbra_leitura_usuario to authenticated;

-- Nenhuma policy de INSERT/UPDATE/DELETE: escrita nao passa por aqui.
revoke all on public.ulbra_conversas from authenticated, anon, public;
revoke all on public.ulbra_atendimentos from authenticated, anon, public;
revoke all on public.ulbra_sync_estado from authenticated, anon, public;
grant select on public.ulbra_conversas to authenticated;
grant select on public.ulbra_atendimentos to authenticated;
grant select on public.ulbra_sync_estado to authenticated;

-- ============================================================================
-- ESCRITA 1: a porta da sincronizacao
-- ============================================================================
create or replace function public.ulbra_sync_gravar(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dia        date := coalesce((p_payload->>'dia')::date, current_date);
  v_chamadas   integer := coalesce((p_payload->>'chamadas')::integer, 0);
  v_ciclo      text := coalesce(p_payload->>'ciclo', 'OK');
  v_conversas  integer := 0;
  v_atend      integer := 0;
begin
  -- Conversas: upsert. `nao_lidas` SO cresce quando a mensagem nova e do
  -- cliente e e mais recente que a ultima gravada -- repetir o ciclo nao
  -- infla o contador, e mensagem do bot ou do operador nao conta.
  with entrada as (
    select * from jsonb_to_recordset(coalesce(p_payload->'conversas', '[]'::jsonb)) as x(
      ulbra_conversa_id text, ulbra_cliente_id text, cliente_nome text, canal text,
      situacao text, equipe text, responsavel_ulbra text, ultima_mensagem_em timestamptz,
      ultima_mensagem_quem text, ultima_mensagem_previa text,
      ultima_mensagem_cliente_em timestamptz, aluno_id uuid, aluno_status text
    )
  ), gravado as (
    insert into public.ulbra_conversas as c (
      ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe,
      responsavel_ulbra, ultima_mensagem_em, ultima_mensagem_quem, ultima_mensagem_previa,
      ultima_mensagem_cliente_em, aluno_id, aluno_status, atualizado_em
    )
    select
      e.ulbra_conversa_id, e.ulbra_cliente_id, e.cliente_nome, coalesce(e.canal, 'whatsapp'),
      e.situacao, e.equipe, e.responsavel_ulbra, e.ultima_mensagem_em, e.ultima_mensagem_quem,
      e.ultima_mensagem_previa,
      e.ultima_mensagem_cliente_em,
      e.aluno_id, e.aluno_status, now()
    from entrada e
    on conflict (ulbra_conversa_id) do update set
      cliente_nome = excluded.cliente_nome,
      situacao = excluded.situacao,
      responsavel_ulbra = excluded.responsavel_ulbra,
      ultima_mensagem_em = excluded.ultima_mensagem_em,
      ultima_mensagem_quem = excluded.ultima_mensagem_quem,
      ultima_mensagem_previa = excluded.ultima_mensagem_previa,
      -- so sobe: mensagem antiga relida nao rebaixa a ultima do cliente
      ultima_mensagem_cliente_em = greatest(c.ultima_mensagem_cliente_em,
                                            excluded.ultima_mensagem_cliente_em),
      aluno_id = excluded.aluno_id,
      aluno_status = excluded.aluno_status,
      atualizado_em = now()
    where excluded.ultima_mensagem_em is distinct from c.ultima_mensagem_em
       or excluded.situacao is distinct from c.situacao
       or excluded.aluno_status is distinct from c.aluno_status
       or excluded.ultima_mensagem_cliente_em is distinct from c.ultima_mensagem_cliente_em
    returning 1
  )
  select count(*) into v_conversas from gravado;

  -- Atendimentos: upsert que NUNCA mexe em quem ja assumiu nem em quem foi
  -- dispensado. Reler a lista da ULBRA nao tira o caso de ninguem.
  with entrada as (
    select * from jsonb_to_recordset(coalesce(p_payload->'atendimentos', '[]'::jsonb)) as x(
      ulbra_atendimento_id text, ulbra_cliente_id text, cliente_nome text, equipe text,
      situacao text, coluna text, entrou_em timestamptz, aluno_id uuid, aluno_status text,
      destino_email text, destino_motivo text
    )
  ), gravado as (
    insert into public.ulbra_atendimentos as a (
      ulbra_atendimento_id, ulbra_cliente_id, cliente_nome, equipe, situacao, coluna,
      entrou_em, aluno_id, aluno_status, destino_email, destino_motivo, atualizado_em
    )
    select
      e.ulbra_atendimento_id, e.ulbra_cliente_id, e.cliente_nome, e.equipe, e.situacao,
      e.coluna, e.entrou_em, e.aluno_id, e.aluno_status, e.destino_email, e.destino_motivo, now()
    from entrada e
    on conflict (ulbra_atendimento_id) do update set
      situacao = excluded.situacao,
      coluna = excluded.coluna,
      cliente_nome = excluded.cliente_nome,
      aluno_id = excluded.aluno_id,
      aluno_status = excluded.aluno_status,
      -- destino so e re-sugerido enquanto ninguem assumiu
      destino_email = case when a.responsavel_email is null then excluded.destino_email
                           else a.destino_email end,
      destino_motivo = case when a.responsavel_email is null then excluded.destino_motivo
                            else a.destino_motivo end,
      atualizado_em = now()
    where a.dispensado_em is null
    returning 1
  )
  select count(*) into v_atend from gravado;

  -- FILA DE DETALHES. Ordem importa: enfileirar antes de concluir/desistir,
  -- para que uma conversa lida no mesmo ciclo em que entrou nao fique para tras.
  insert into public.ulbra_detalhe_fila (ulbra_conversa_id, ulbra_cliente_id, na_lista_em)
  select x.ulbra_conversa_id, x.ulbra_cliente_id, x.na_lista_em
    from jsonb_to_recordset(coalesce(p_payload->'detalhe_enfileirar', '[]'::jsonb)) as x(
      ulbra_conversa_id text, ulbra_cliente_id text, na_lista_em timestamptz)
  on conflict (ulbra_conversa_id) do nothing;

  -- Lida: a data do cliente vai para o espelho (so sobe), e sai da fila.
  update public.ulbra_conversas c set
    ultima_mensagem_cliente_em = greatest(c.ultima_mensagem_cliente_em, x.em)
    from (
      select (e->>'ulbra_conversa_id') as id, (e->>'ultima_mensagem_cliente_em')::timestamptz as em
        from jsonb_array_elements(coalesce(p_payload->'detalhe_concluidas', '[]'::jsonb)) e
    ) x
   where c.ulbra_conversa_id = x.id and x.em is not null;

  delete from public.ulbra_detalhe_fila f
   where f.ulbra_conversa_id in (
     select e->>'ulbra_conversa_id'
       from jsonb_array_elements(coalesce(p_payload->'detalhe_concluidas', '[]'::jsonb)) e
   );

  -- Continuar: a leitura de detalhe pediu mais uma pagina. Nao e falha.
  update public.ulbra_detalhe_fila f set antes_de = x.antes_de, paginas_lidas = x.paginas_lidas
    from jsonb_to_recordset(coalesce(p_payload->'detalhe_continuar', '[]'::jsonb)) as x(
      ulbra_conversa_id text, antes_de text, paginas_lidas integer)
   where f.ulbra_conversa_id = x.ulbra_conversa_id;

  -- Esgotadas: viram PENDENCIA (preservada) e saem da fila ativa.
  insert into public.ulbra_detalhe_pendencias (ulbra_conversa_id, ulbra_cliente_id, na_lista_em, motivo, antes_de)
  select x.ulbra_conversa_id, x.ulbra_cliente_id, x.na_lista_em,
         coalesce(x.motivo, 'FALHAS_ESGOTADAS'), nullif(x.antes_de, '')
    from jsonb_to_recordset(coalesce(p_payload->'detalhe_pendencias', '[]'::jsonb)) as x(
      ulbra_conversa_id text, ulbra_cliente_id text, na_lista_em timestamptz,
      motivo text, antes_de text)
  on conflict (ulbra_conversa_id) do nothing;
  delete from public.ulbra_detalhe_fila f
   where f.ulbra_conversa_id in (
     select x->>'ulbra_conversa_id'
       from jsonb_array_elements(coalesce(p_payload->'detalhe_pendencias', '[]'::jsonb)) x);

  -- Saldo diario lido de meu_acesso (so quando veio).
  update public.ulbra_sync_estado set
    saldo_api_restam = (p_payload->'saldo_api'->>'restam')::integer,
    saldo_api_em = (p_payload->'saldo_api'->>'em')::timestamptz
   where id and p_payload->'saldo_api' is not null and jsonb_typeof(p_payload->'saldo_api') = 'object';

  -- Falhou: uma tentativa a mais. A desistencia so acontece na leitura seguinte.
  update public.ulbra_detalhe_fila f set tentativas = f.tentativas + 1
   where f.ulbra_conversa_id in (
     select jsonb_array_elements_text(coalesce(p_payload->'detalhe_falhas', '[]'::jsonb)));

  -- A janela so se move quando o ciclo NAO falha. Falha grava nada de janela:
  -- o proximo ciclo refaz a mesma coleta, e o upsert e idempotente.
  update public.ulbra_sync_estado set
    cursor_mensagem = case when v_ciclo <> 'FALHOU' and (p_payload ? 'cursor')
                           then (p_payload->>'cursor')::timestamptz
                           else cursor_mensagem end,
    piso_pendente = case when v_ciclo <> 'FALHOU' and (p_payload ? 'piso_pendente')
                         then (p_payload->>'piso_pendente')::timestamptz
                         else piso_pendente end,
    topo_processado = case when v_ciclo <> 'FALHOU' and (p_payload ? 'topo_processado')
                           then (p_payload->>'topo_processado')::timestamptz
                           else topo_processado end,
    ultima_execucao = now(),
    ultimo_ciclo = v_ciclo,
    ultimo_erro = p_payload->>'erro',
    chamadas_dia = case when dia = v_dia then chamadas_dia + v_chamadas else v_chamadas end,
    dia = v_dia,
    detalhe_fila_tamanho = (select count(*) from public.ulbra_detalhe_fila),
    detalhes_pendencias_abertas = (select count(*) from public.ulbra_detalhe_pendencias
                                    where recuperada_em is null),
    alerta_gestao = case when (select count(*) from public.ulbra_detalhe_pendencias
                                where recuperada_em is null) > 0
      then 'PENDENCIA: ' || (select count(*) from public.ulbra_detalhe_pendencias
                              where recuperada_em is null)
           || ' conversa(s) sem leitura de detalhe apos 5 falhas. Revisar e reabrir.'
      else null end,
    ciclos_desde_atendimentos = case
      when coalesce((p_payload->>'atendimentos_lidos')::boolean, false) then 0
      else ciclos_desde_atendimentos + 1 end
  where id;

  return jsonb_build_object('conversas', v_conversas, 'atendimentos', v_atend, 'ciclo', v_ciclo);
end;
$$;

comment on function public.ulbra_sync_gravar(jsonb) is
  'Unica porta de escrita do espelho da Mensageria. So service_role: a funcao ulbra-sincronizar chama, mais ninguem.';

revoke all on function public.ulbra_sync_gravar(jsonb) from public, anon, authenticated;
grant execute on function public.ulbra_sync_gravar(jsonb) to service_role;

-- ============================================================================
-- ESCRITA 2: posse, dispensa e leitura -- acoes da tela
-- ============================================================================

-- A TRAVA CONTRA DOIS DONOS. O `where responsavel_email is null` e o que
-- impede dois operadores de assumirem o mesmo atendimento: o segundo UPDATE
-- nao encontra linha e a funcao devolve `ja_assumido`, com o nome de quem
-- chegou primeiro. Nao depende de nada da tela.
create or replace function public.ulbra_atendimento_assumir(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := app_email();
  v_linha public.ulbra_atendimentos;
begin
  if not app_usuario_ativo() or eh_painel() then
    return jsonb_build_object('ok', false, 'motivo', 'ACESSO_NEGADO');
  end if;

  select * into v_linha from public.ulbra_atendimentos where ulbra_atendimento_id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'NAO_ENCONTRADO');
  end if;
  if v_linha.dispensado_em is not null then
    return jsonb_build_object('ok', false, 'motivo', 'DISPENSADO');
  end if;
  -- Identidade nao confirmada nao se assume: vai para conferencia primeiro.
  if v_linha.aluno_status <> 'vinculado' then
    return jsonb_build_object('ok', false, 'motivo', 'IDENTIDADE_NAO_CONFIRMADA');
  end if;
  -- Carteira: se o aluno tem dono, so o dono (ou a gestao) assume.
  if v_linha.destino_motivo = 'CARTEIRA'
     and lower(coalesce(v_linha.destino_email, '')) <> lower(coalesce(v_email, ''))
     and not usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'motivo', 'E_DA_CARTEIRA_DE_OUTRO',
                              'destino', v_linha.destino_email);
  end if;

  update public.ulbra_atendimentos
     set responsavel_email = v_email, assumido_em = now(), atualizado_em = now()
   where ulbra_atendimento_id = p_id
     and responsavel_email is null
     and dispensado_em is null
  returning * into v_linha;

  if not found then
    select * into v_linha from public.ulbra_atendimentos where ulbra_atendimento_id = p_id;
    return jsonb_build_object('ok', false, 'motivo', 'JA_ASSUMIDO',
                              'responsavel', v_linha.responsavel_email);
  end if;

  return jsonb_build_object('ok', true, 'responsavel', v_linha.responsavel_email);
end;
$$;

create or replace function public.ulbra_atendimento_dispensar(p_id text, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := app_email();
begin
  if not app_usuario_ativo() or eh_painel() then
    return jsonb_build_object('ok', false, 'motivo', 'ACESSO_NEGADO');
  end if;
  update public.ulbra_atendimentos
     set dispensado_em = now(), dispensado_por = v_email,
         dispensa_motivo = nullif(btrim(coalesce(p_motivo, '')), ''), atualizado_em = now()
   where ulbra_atendimento_id = p_id
     and dispensado_em is null
     and (responsavel_email is null
          or lower(responsavel_email) = lower(coalesce(v_email, ''))
          or usuario_e_gestao());
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'NAO_PERMITIDO_OU_JA_DISPENSADO');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.ulbra_conversa_marcar_lida(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(app_email(), ''));
  v_ultima timestamptz;
begin
  if v_email = '' or not app_usuario_ativo() or eh_painel() then
    return jsonb_build_object('ok', false, 'motivo', 'ACESSO_NEGADO');
  end if;
  -- Marca ate onde ESTE usuario leu. Nao mexe na conversa nem em quem leu
  -- antes ou depois: cada operador tem a sua linha.
  select ultima_mensagem_cliente_em into v_ultima
    from public.ulbra_conversas where ulbra_conversa_id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'NAO_ENCONTRADO');
  end if;
  insert into public.ulbra_leitura_usuario (usuario_email, ulbra_conversa_id, lido_ate, atualizado_em)
  values (v_email, p_id, coalesce(v_ultima, now()), now())
  on conflict (usuario_email, ulbra_conversa_id) do update
    set lido_ate = greatest(ulbra_leitura_usuario.lido_ate, excluded.lido_ate),
        atualizado_em = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- Reabre uma pendencia: volta a fila com tentativas zeradas. So gestao.
-- A pendencia nao some: ganha data e autor de recuperacao.
create or replace function public.ulbra_detalhe_reabrir(p_conversa text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_linha public.ulbra_detalhe_pendencias;
begin
  if not usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'motivo', 'ACESSO_NEGADO');
  end if;
  update public.ulbra_detalhe_pendencias
     set recuperada_em = now(), recuperada_por = app_email()
   where ulbra_conversa_id = p_conversa and recuperada_em is null
  returning * into v_linha;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'NAO_PENDENTE');
  end if;
  insert into public.ulbra_detalhe_fila (ulbra_conversa_id, ulbra_cliente_id, na_lista_em, tentativas, antes_de, paginas_lidas)
  values (v_linha.ulbra_conversa_id, v_linha.ulbra_cliente_id, v_linha.na_lista_em, 0, v_linha.antes_de, 0)
  on conflict (ulbra_conversa_id) do update
    set tentativas = 0, antes_de = excluded.antes_de, paginas_lidas = 0;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.ulbra_conversa_marcar_lida(text) from public, anon;
revoke all on function public.ulbra_atendimento_assumir(text) from public, anon;
revoke all on function public.ulbra_atendimento_dispensar(text, text) from public, anon;
revoke all on function public.ulbra_detalhe_reabrir(text) from public, anon;
grant execute on function public.ulbra_detalhe_reabrir(text) to authenticated;
grant execute on function public.ulbra_conversa_marcar_lida(text) to authenticated;

-- PILOTO DE OBSERVACAO (autorizado em 08/11/2026) -----------------------------
-- `assumir` e `dispensar` NAO recebem EXECUTE de `authenticated`. As funcoes
-- ficam criadas -- o codigo e as provas continuam valendo e o fim do piloto so
-- reconcede --, mas no piloto NINGUEM alem de `service_role` as executa.
--
-- Por que o grant era o unico portao: as duas sao `security definer`. Sem
-- EXECUTE a chamada morre antes de entrar na funcao; com EXECUTE, quem decide
-- e a regra interna. O piloto nao quer a regra interna, quer a porta fechada.
--
-- O REVOKE e explicito em vez de "nao conceder" de proposito: o ambiente tem
-- `alter default privileges ... grant execute on functions to authenticated`
-- (reproduzido em 01_ambiente.sql), que faz funcao nova nascer executavel.
-- Omitir o grant NAO bastaria.
revoke all on function public.ulbra_atendimento_assumir(text)         from public, anon, authenticated;
revoke all on function public.ulbra_atendimento_dispensar(text, text) from public, anon, authenticated;

-- ============================================================================
-- DISPARADOR DO CRON. Define a funcao, NAO agenda. O agendamento e o ultimo
-- passo do pacote, depois da funcao publicada: agendar antes faria o cron bater
-- num endpoint que ainda nao existe.
--
-- Mesmo padrao das rotinas existentes do repositorio (projeto_url e segredo no
-- Vault, net.http_post). Sem grant para anon/authenticated: so o cron, que roda
-- como postgres, chama.
-- ============================================================================
create or replace function public.ulbra_sincronizar_disparar()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net, pg_temp
as $$
declare
  v_url   text;
  v_chave text;
  v_req   bigint;
begin
  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'projeto_url';
  select decrypted_secret into v_chave from vault.decrypted_secrets where name = 'ulbra_sync_chave';
  if v_url is null or v_chave is null then
    raise exception 'SEGREDO_AUSENTE: projeto_url ou ulbra_sync_chave';
  end if;

  select net.http_post(
    url     := rtrim(v_url, '/') || '/functions/v1/ulbra-sincronizar',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-chave', v_chave),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) into v_req;
  return v_req;
end;
$$;

revoke all on function public.ulbra_sincronizar_disparar() from public, anon, authenticated;

commit;

-- ============================================================================
-- DEPOIS DESTE SQL -- EM PASSOS SEPARADOS, CADA UM COM AUTORIZACAO
--
--   1. publicar a funcao `ulbra-sincronizar` com `verify_jwt = false`
--      (o portao dela e o cabecalho `x-sync-chave`);
--   2. gravar o segredo `ULBRA_SYNC_CHAVE` no ambiente da funcao e no Vault
--      do banco (nome sugerido: `ulbra_sync_chave`);
--   3. so entao criar o cron de 10 minutos, que e o numero que cabe no teto
--      de 500 chamadas/dia com folga para as fichas. O cron NAO carrega o
--      segredo: chama o disparador, que le do Vault.
--
--      select cron.schedule('ulbra_sincronizar', '*/10 * * * *',
--        $cron$ select public.ulbra_sincronizar_disparar(); $cron$);
--
--      `ulbra_sincronizar_disparar()` (criada acima) le `projeto_url` e
--      `ulbra_sync_chave` de `vault.decrypted_secrets`, monta o `net.http_post`
--      com o cabecalho `x-sync-chave` e levanta SEGREDO_AUSENTE se faltar
--      qualquer um dos dois. Ela ja esta revogada de `public`, `anon` e
--      `authenticated`.
--
--      POR QUE ASSIM, e nao com a chave no corpo do cron: o corpo fica em
--      `cron.job`, que e tabela legivel -- a chave viraria segredo guardado em
--      texto numa tabela de agendamento. Chamando o disparador, a definicao do
--      cron nao contem segredo nenhum.
--
--   Antes do passo 3, o ciclo pode ser disparado a mao, uma vez, pela mesma
--   funcao, para conferir o resultado com alguem olhando.
-- ============================================================================
