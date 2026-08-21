-- =============================================================================
-- DESFAZER a ação recém-feita: termo, link e tabulação
--
-- O problema: o operador manda o termo do aluno A anexado na ficha do aluno B,
-- ou pede o link no nome errado, e hoje não existe volta. Sobra erro em três
-- lugares ao mesmo tempo: a ficha do aluno errado (o status é sobrescrito), a
-- fila do ADM (que trabalha um pedido que não existe) e — no termo — o
-- documento de um aluno pendurado na ficha de outro, que é vazamento de PII.
--
-- Quem desfaz: o PRÓPRIO operador, enquanto o ADM não pegou o item. Assumido,
-- gerado ou validado pelo ADM, o botão morre para o operador e só a gestão
-- desfaz. Tabulação não tem ADM do outro lado: vale por 24h e só enquanto for
-- a última ação do aluno.
--
-- O que desfazer NUNCA faz: apagar linha. Termo e link viram CANCELADO com
-- rastro de quem desfez e por quê; a movimentação continua no histórico, só
-- muda de tipo para parar de contar como acionamento (senão o erro segue
-- valendo ponto no Meu Dashboard). O anexo do termo é o único que some de
-- verdade — documento na ficha errada não pode ficar.
--
-- Peças:
--   1. alunos_estado_anterior -- foto do aluno ANTES de cada mudança de status
--   2. acoes_desfazer         -- um cartão por ação reversível
--   3. gatilhos que criam o cartão (termo, tabulação) e a RPC do link
--   4. desfazer_listar / desfazer_acao
--   5. correção do sincronizar_aluno_com_link (bug já existente, ver abaixo)
-- =============================================================================

-- 1) Foto do estado anterior do aluno --------------------------------------
--    Só a tabulação precisa dela: o frontend grava a ficha ANTES de registrar a
--    movimentação, então quando o cartão nasce o estado antigo já se perdeu.
--    Termo e link leem a ficha direto (o cartão nasce antes da escrita).
create table if not exists public.alunos_estado_anterior (
  id         bigserial primary key,
  aluno_id   uuid not null,
  estado     jsonb not null,
  ator       text,
  criado_em  timestamptz not null default now()
);

create index if not exists ix_estado_anterior_aluno
  on public.alunos_estado_anterior (aluno_id, id desc);

alter table public.alunos_estado_anterior enable row level security;
-- Deny-all proposital: ninguém lê direto, só as RPCs SECURITY DEFINER abaixo.

comment on table public.alunos_estado_anterior is
  'Foto dos campos de atendimento do aluno antes de cada troca de status feita por gente logada. Insumo do Desfazer; expurgada em 30 dias.';

-- Campos que o desfazer restaura. Deliberadamente NÃO inclui responsável nem
-- criticidade: responsável tem guard próprio (_guard_resp_aluno) e criticidade
-- é derivada, recalculada pelo motor.
create or replace function public._aluno_estado_json(a public.alunos)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'status_jornada',          a.status_jornada,
    'status_atual',            a.status_atual,
    'status_acionamento',      a.status_acionamento,
    'proxima_acao',            a.proxima_acao,
    'data_retorno',            a.data_retorno,
    'hora_retorno',            a.hora_retorno,
    'observacao',              a.observacao,
    'data_ultimo_acionamento', a.data_ultimo_acionamento,
    'ultimo_contato',          a.ultimo_contato,
    'registrado_em',           a.registrado_em,
    'registrado_por_email',    a.registrado_por_email,
    'registrado_por_nome',     a.registrado_por_nome
  );
$$;

create or replace function public._trg_aluno_estado_anterior()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Só ação de gente logada. Cron, service_role e nivelamento entram sem JWT e
  -- movem milhares de linhas por rodada -- fotografar isso encheria a tabela
  -- sem nunca virar um botão de desfazer para ninguém.
  if public.app_email() = '' then
    return new;
  end if;

  -- Válvula para rotinas em lote que rodam sob o JWT de alguém e não devem
  -- gerar foto (set local reativa.sem_snapshot = '1').
  if coalesce(current_setting('reativa.sem_snapshot', true), '') = '1' then
    return new;
  end if;

  insert into public.alunos_estado_anterior (aluno_id, estado, ator)
  values (old.id, public._aluno_estado_json(old), public.app_email());

  return new;
exception when others then
  -- Falha na foto nunca pode impedir o atendimento de ser gravado.
  return new;
end;
$$;

drop trigger if exists trg_aluno_estado_anterior on public.alunos;
create trigger trg_aluno_estado_anterior
  before update on public.alunos
  for each row
  when (old.status_atual is distinct from new.status_atual)
  execute function public._trg_aluno_estado_anterior();

-- 2) O cartão de desfazer ---------------------------------------------------
create table if not exists public.acoes_desfazer (
  id               uuid primary key default gen_random_uuid(),
  tipo             text not null check (tipo in ('TERMO_ENVIADO','LINK_SOLICITADO','TABULACAO')),
  aluno_id         uuid not null,
  aluno_nome       text,
  referencia_id    uuid,      -- termos_acordo.id / links_pagamento.id
  movimentacao_id  bigint,    -- aluno_movimentacoes.id (tabulação e link)
  operador_email   text not null,
  operador_nome    text,
  rotulo           text not null,
  estado_anterior  jsonb,
  atribuiu_responsavel boolean not null default false,
  criado_em        timestamptz not null default now(),
  desfeito_em      timestamptz,
  desfeito_por     text,
  motivo           text,
  resultado        jsonb
);

create index if not exists ix_acoes_desfazer_operador
  on public.acoes_desfazer (operador_email, criado_em desc)
  where desfeito_em is null;

create index if not exists ix_acoes_desfazer_aluno
  on public.acoes_desfazer (aluno_id, criado_em desc);

alter table public.acoes_desfazer enable row level security;
-- Deny-all proposital: leitura e escrita só pelas RPCs abaixo.

comment on table public.acoes_desfazer is
  'Um cartão por ação que ainda pode ser desfeita (termo enviado, link solicitado, tabulação). Nunca é apagado ao desfazer: recebe desfeito_em/desfeito_por/motivo.';

-- 3) Quem cria o cartão -----------------------------------------------------

-- 3.a) Termo enviado ao ADM.
--      Dispara no INSERT do termo, ANTES de o frontend sobrescrever o status do
--      aluno -- por isso lê a ficha aqui e guarda a foto junto. O nome começa
--      com 00 de propósito: gatilho AFTER roda em ordem alfabética e este
--      precisa vir antes do trg_recalc_termo_ins, que já mexe na ficha.
--      gov.br (TERMO_LIBERADO_AUTOMATICO_GOV) fica de fora: já nasce liberado,
--      desfazer ali é decisão de gestão, não de operador.
create or replace function public._trg_desfazer_cartao_termo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_aluno public.alunos%rowtype;
begin
  if new.status <> 'TERMO_ENVIADO_ADM' then
    return null;
  end if;

  begin
    select * into v_aluno from public.alunos where id = new.aluno_id::uuid;
  exception when others then
    return null;
  end;
  if not found then
    return null;
  end if;

  insert into public.acoes_desfazer
    (tipo, aluno_id, aluno_nome, referencia_id, operador_email, operador_nome,
     rotulo, estado_anterior)
  values
    ('TERMO_ENVIADO', v_aluno.id, new.aluno_nome, new.id,
     lower(coalesce(new.operador_email, public.app_email())), new.operador_nome,
     'Termo enviado para a fila do ADM', public._aluno_estado_json(v_aluno));

  return null;
exception when others then
  -- O cartão é conveniência: falhar aqui não pode derrubar o envio do termo.
  return null;
end;
$$;

drop trigger if exists trg_00_desfazer_cartao_termo on public.termos_acordo;
create trigger trg_00_desfazer_cartao_termo
  after insert on public.termos_acordo
  for each row execute function public._trg_desfazer_cartao_termo();

-- 3.b) Tabulação / finalização de atendimento.
--      Aqui a ficha JÁ foi gravada quando a movimentação chega, então a foto vem
--      de alunos_estado_anterior. A âncora é o status_anterior da própria
--      movimentação: entre a gravação da ficha e a movimentação um recálculo
--      pode ter deixado outra foto no meio, e pegar "a última" às cegas
--      restauraria o estado errado.
create or replace function public._trg_desfazer_cartao_tabulacao()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_aluno uuid;
  v_estado jsonb;
  v_nome text;
begin
  if new.tipo <> 'FINALIZACAO_ATENDIMENTO' then
    return null;
  end if;
  if public.app_email() = '' then
    return null;   -- ação de sistema não vira botão de desfazer
  end if;

  begin
    v_aluno := new.aluno_id::uuid;
  exception when others then
    return null;
  end;

  -- Link e termo já criaram o cartão nesta mesma transação (now() é estável
  -- dentro dela) e a movimentação abaixo é parte da MESMA ação. Sem isso,
  -- solicitar link geraria dois cartões. A checagem exclui TABULACAO de
  -- propósito: duas tabulações na mesma transação são duas ações de verdade e
  -- cada uma precisa do seu cartão.
  if exists (
    select 1 from public.acoes_desfazer
     where aluno_id = v_aluno and criado_em = now() and tipo <> 'TABULACAO'
  ) then
    return null;
  end if;

  select ea.estado into v_estado
    from public.alunos_estado_anterior ea
   where ea.aluno_id = v_aluno
     and ea.estado->>'status_atual' is not distinct from new.status_anterior
   order by ea.id desc
   limit 1;

  if v_estado is null then
    select ea.estado into v_estado
      from public.alunos_estado_anterior ea
     where ea.aluno_id = v_aluno
     order by ea.id desc
     limit 1;
  end if;

  -- Sem foto nenhuma ainda dá para voltar o status, que é o que mais dói.
  if v_estado is null then
    v_estado := jsonb_build_object(
      'status_jornada',     new.status_anterior,
      'status_atual',       new.status_anterior,
      'status_acionamento', new.status_anterior
    );
  end if;

  select coalesce(nome_aluno, nome) into v_nome from public.alunos where id = v_aluno;

  insert into public.acoes_desfazer
    (tipo, aluno_id, aluno_nome, movimentacao_id, operador_email, operador_nome,
     rotulo, estado_anterior)
  values
    ('TABULACAO', v_aluno, v_nome, new.id,
     lower(coalesce(new.registrado_por_email, public.app_email())), new.registrado_por_nome,
     'Atendimento tabulado como "' || coalesce(new.status_novo, '-') || '"', v_estado);

  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists trg_zz_desfazer_cartao_tabulacao on public.aluno_movimentacoes;
create trigger trg_zz_desfazer_cartao_tabulacao
  after insert on public.aluno_movimentacoes
  for each row execute function public._trg_desfazer_cartao_tabulacao();

-- 3.c) Link solicitado.
--      Recriada aqui igual à que roda em produção (ela nunca esteve no repo),
--      com uma adição: a foto da ficha é tirada ANTES de qualquer escrita e o
--      cartão nasce antes do update do aluno. A ordem importa -- o cartão
--      precisa existir quando a movimentação FINALIZACAO_ATENDIMENTO for
--      inserida logo abaixo, senão o gatilho 3.b criaria um cartão duplicado.
create or replace function public.solicitar_link_pagamento(
  p_aluno_id text,
  p_aluno_nome text,
  p_aluno_cpf text,
  p_operador_solicitante text,
  p_operador_nome text,
  p_valor numeric,
  p_parcelas integer,
  p_data_vencimento date,
  p_observacao text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'internal'
as $$
declare
  v_id uuid;
  v_email text;
  v_status_antigo text;
  v_aluno public.alunos%rowtype;
  v_estado jsonb;
  v_atribuiu boolean := false;
begin
  v_email := lower(trim(coalesce(p_operador_solicitante,'')));
  if v_email='' or position('@' in v_email)=0 then
    raise exception 'Operador solicitante sem e-mail válido. Saia e entre novamente no CRM.';
  end if;

  select * into v_aluno from public.alunos where id::text = p_aluno_id;
  v_status_antigo := v_aluno.status_atual;
  v_estado := case when v_aluno.id is null then null else public._aluno_estado_json(v_aluno) end;

  insert into public.links_pagamento (aluno_id,aluno_nome,aluno_cpf,operador_solicitante,operador_email,operador_nome,valor,parcelas,data_vencimento,observacao,status,criado_em,atualizado_em)
  values (p_aluno_id,p_aluno_nome,p_aluno_cpf,v_email,v_email,p_operador_nome,p_valor,coalesce(p_parcelas,1),p_data_vencimento,p_observacao,'SOLICITADO_LINK',now(),now())
  returning id into v_id;

  insert into public.historico_links_pagamento (link_id,aluno_id,aluno_nome,aluno_cpf,status_anterior,status_novo,descricao,usuario_email,usuario_nome)
  values (v_id,p_aluno_id,p_aluno_nome,p_aluno_cpf,null,'SOLICITADO_LINK','Link solicitado pelo operador e enviado para ADM/Fernanda.',v_email,p_operador_nome);

  v_atribuiu := (v_aluno.id is not null and coalesce(v_aluno.responsavel_atual_email,'') = '');

  if v_aluno.id is not null then
    insert into public.acoes_desfazer
      (tipo, aluno_id, aluno_nome, referencia_id, operador_email, operador_nome,
       rotulo, estado_anterior, atribuiu_responsavel)
    values
      ('LINK_SOLICITADO', v_aluno.id, p_aluno_nome, v_id, v_email, p_operador_nome,
       'Link de R$ ' || coalesce(replace(to_char(p_valor,'FM9999999990.00'), '.', ','), '-') ||
         ' em ' || coalesce(p_parcelas,1) || 'x solicitado ao ADM',
       v_estado, v_atribuiu);
  end if;

  update public.alunos set status_jornada='SOLICITADO_LINK', status_atual='SOLICITADO_LINK', status_acionamento='SOLICITADO_LINK',
    proxima_acao='AGUARDAR_LINK', registrado_em=now(), data_ultimo_acionamento=now()
  where id::text = p_aluno_id;

  -- Registra tambem em aluno_movimentacoes com o tipo que conta como
  -- acionamento no Meu Dashboard -- senao solicitar link nao contava em
  -- nada pro operador (mesmo bug que corrigimos no envio de e-mail).
  insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
  values (p_aluno_id, 'FINALIZACAO_ATENDIMENTO', 'Link de pagamento solicitado (' || coalesce(p_valor::text,'-') || ', ' || coalesce(p_parcelas,1) || 'x).', v_status_antigo, 'SOLICITADO_LINK', p_operador_nome, v_email, now());

  -- Amarra a movimentação recém-criada ao cartão: é ela que o desfazer precisa
  -- despromover para o erro parar de contar como acionamento.
  update public.acoes_desfazer
     set movimentacao_id = currval(pg_get_serial_sequence('public.aluno_movimentacoes','id'))
   where referencia_id = v_id and tipo = 'LINK_SOLICITADO';

  if (select responsavel_atual_email from public.alunos where id::text = p_aluno_id) is null then
    perform internal.set_resp_aluno(p_aluno_id::uuid, v_email, p_operador_nome, 'ALTERACAO_OPERADOR',
      'Atribuido ao solicitante do link (caso sem responsavel). Origem: solicitar_link.', v_email, p_operador_nome);
  end if;
  return v_id;
end;
$$;

-- 4) Correção: cancelar link NÃO pode carimbar a ficha do aluno -------------
--    Bug já existente, anterior ao desfazer: o trigger copia o status do link
--    para o aluno, então o "Cancelar" do ADM deixava a ficha com
--    status_atual = 'CANCELADO' -- em produção sobrou um aluno assim. Cancelar
--    é estado do PEDIDO, não do aluno. Quem cancela é que decide o que a ficha
--    vira (o desfazer restaura a foto anterior; o cancelamento do ADM deixa
--    como está).
create or replace function public.sincronizar_aluno_com_link()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_status_aluno text;
  v_proxima_acao text;
  v_uuid uuid;
begin
  if to_regclass('public.alunos') is null then
    return new;
  end if;

  if new.aluno_nome is null then
    return new;
  end if;

  if new.status = 'CANCELADO' then
    return new;
  end if;

  v_status_aluno := new.status;

  v_proxima_acao :=
    case new.status
      when 'SOLICITADO_LINK' then 'AGUARDAR_LINK'
      when 'LINK_EM_ATENDIMENTO' then 'LINK_EM_ATENDIMENTO_ADM'
      when 'LINK_PRONTO_PARA_ENVIO' then 'ENVIAR_LINK_AO_ALUNO'
      when 'LINK_ENVIADO_AO_ALUNO' then 'AGUARDAR_COMPROVANTE'
      when 'AGUARDANDO_BAIXA' then 'AGUARDANDO_BAIXA'
      when 'BAIXA_REALIZADA' then 'BAIXA_REALIZADA'
      when 'BAIXA_DEVOLVIDA' then 'CORRIGIR_BAIXA'
      else new.status
    end;

  if new.aluno_id is not null then
    begin
      v_uuid := new.aluno_id::uuid;
    exception when others then
      v_uuid := null;
    end;

    update public.alunos
       set status_acionamento = v_status_aluno,
           status_atual       = v_status_aluno,
           status_jornada     = v_status_aluno,
           proxima_acao       = v_proxima_acao,
           atualizado_em      = now()
     where id = v_uuid;

    return new;
  end if;

  if new.aluno_cpf is not null then
    update public.alunos
       set status_acionamento = v_status_aluno,
           status_atual       = v_status_aluno,
           status_jornada     = v_status_aluno,
           proxima_acao       = v_proxima_acao,
           atualizado_em      = now()
     where regexp_replace(cpf::text, '[^0-9]', '', 'g')
         = regexp_replace(new.aluno_cpf::text, '[^0-9]', '', 'g');
    return new;
  end if;

  update public.alunos
     set status_acionamento = v_status_aluno,
         status_atual       = v_status_aluno,
         status_jornada     = v_status_aluno,
         proxima_acao       = v_proxima_acao,
         atualizado_em      = now()
   where nome ilike new.aluno_nome;

  return new;
end;
$function$;

-- 4.b) Índice que faltava --------------------------------------------------
--      A checagem "entrou termo depois?" e a própria ficha do aluno filtram
--      termos_acordo por aluno_id, que só tinha índice por id e por etapa.
create index if not exists ix_termos_acordo_aluno on public.termos_acordo (aluno_id);

-- 5) Ainda dá para desfazer? ------------------------------------------------
--    Uma função só, usada pela listagem (para mostrar o motivo) e pelo desfazer
--    (para recusar). Retorna null quando está liberado.
create or replace function public._desfazer_bloqueio(
  p_acao public.acoes_desfazer,
  p_gestao boolean
)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_status text;
  v_ultima bigint;
begin
  if p_acao.desfeito_em is not null then
    return 'ja_desfeito';
  end if;

  if p_acao.tipo = 'TERMO_ENVIADO' then
    select status into v_status from public.termos_acordo where id = p_acao.referencia_id;
    if not found then return 'termo_nao_encontrado'; end if;
    if v_status <> 'TERMO_ENVIADO_ADM' then return 'termo_ja_tratado'; end if;
    return null;
  end if;

  if p_acao.tipo = 'LINK_SOLICITADO' then
    select status into v_status from public.links_pagamento where id = p_acao.referencia_id;
    if not found then return 'link_nao_encontrado'; end if;
    if v_status <> 'SOLICITADO_LINK' then return 'link_ja_em_atendimento'; end if;
    return null;
  end if;

  -- TABULACAO: sem ADM do outro lado, o limite é o tempo e o que veio depois.
  if not coalesce(p_gestao, false) and p_acao.criado_em < now() - interval '24 hours' then
    return 'prazo_expirado';
  end if;

  select max(m.id) into v_ultima
    from public.aluno_movimentacoes m
   where m.aluno_id = p_acao.aluno_id::text
     and public.eh_tipo_acionamento(m.tipo);
  if v_ultima is distinct from p_acao.movimentacao_id then
    return 'houve_acao_depois';
  end if;

  if exists (
    select 1 from public.termos_acordo t
     where t.aluno_id = p_acao.aluno_id::text and t.criado_em > p_acao.criado_em
  ) then
    return 'houve_acao_depois';
  end if;

  -- Tabulado como "pago" abre solicitação de confirmação. Desfazer por baixo
  -- da fila do financeiro deixaria a confirmação órfã: manda falar com o ADM.
  if exists (
    select 1 from public.solicitacoes_confirmacao_pagamento s
     where s.aluno_id = p_acao.aluno_id::text
       and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
       and s.criado_em >= p_acao.criado_em
  ) then
    return 'confirmacao_aberta';
  end if;

  return null;
end;
$$;

-- 6) Listar o que dá para desfazer ------------------------------------------
--    Sem p_aluno_id devolve as ações recentes do próprio operador (para uma
--    barra de "desfazer" geral); com p_aluno_id, as daquele aluno.
create or replace function public.desfazer_listar(
  p_aluno_id uuid default null,
  p_limite int default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_email text := public.app_email();
  v_gestao boolean := public.usuario_e_gestao();
  v_itens jsonb;
begin
  if v_email = '' then
    return jsonb_build_object('ok', false, 'erro', 'sem_sessao');
  end if;

  select coalesce(jsonb_agg(x order by x->>'criado_em' desc), '[]'::jsonb) into v_itens
  from (
    select jsonb_build_object(
             'id', a.id,
             'tipo', a.tipo,
             'rotulo', a.rotulo,
             'aluno_id', a.aluno_id,
             'aluno_nome', a.aluno_nome,
             'operador_email', a.operador_email,
             'criado_em', a.criado_em,
             'bloqueio', public._desfazer_bloqueio(a, v_gestao)
           ) as x
      from public.acoes_desfazer a
     where a.desfeito_em is null
       and (p_aluno_id is null or a.aluno_id = p_aluno_id)
       and (v_gestao or a.operador_email = v_email)
       and a.criado_em > now() - interval '30 days'
     order by a.criado_em desc
     limit greatest(coalesce(p_limite, 10), 1)
  ) t;

  return jsonb_build_object('ok', true, 'itens', v_itens);
end;
$$;

-- 7) Restaurar a ficha ------------------------------------------------------
create or replace function public._desfazer_restaurar_aluno(
  p_aluno_id uuid,
  p_estado jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_estado is null then
    return;
  end if;

  update public.alunos set
    status_jornada          = p_estado->>'status_jornada',
    status_atual            = p_estado->>'status_atual',
    status_acionamento      = p_estado->>'status_acionamento',
    proxima_acao            = p_estado->>'proxima_acao',
    data_retorno            = nullif(p_estado->>'data_retorno','')::date,
    hora_retorno            = p_estado->>'hora_retorno',
    observacao              = p_estado->>'observacao',
    data_ultimo_acionamento = nullif(p_estado->>'data_ultimo_acionamento','')::timestamptz,
    ultimo_contato          = nullif(p_estado->>'ultimo_contato','')::date,
    registrado_em           = nullif(p_estado->>'registrado_em','')::timestamptz,
    registrado_por_email    = p_estado->>'registrado_por_email',
    registrado_por_nome     = p_estado->>'registrado_por_nome',
    atualizado_em           = now()
  where id = p_aluno_id;
end;
$$;

-- 8) Desfazer ---------------------------------------------------------------
--    p_ator/p_gestao só são obedecidos quando NÃO há JWT (Edge Function com
--    service_role) -- padrão de executor técnico já usado no resto do sistema.
--    Com sessão de gente, quem manda é o JWT.
--
--    Termo devolve os caminhos dos anexos em 'itens': quem apaga do Storage é a
--    Edge Function, que é a única com permissão. Mesma ordem do descarte de
--    vias: registrar -> apagar -> confirmar, para não gerar órfão silencioso.
create or replace function public.desfazer_acao(
  p_id uuid,
  p_motivo text default null,
  p_ator text default null,
  p_gestao boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
as $$
declare
  v_acao public.acoes_desfazer%rowtype;
  v_sem_jwt boolean := (auth.jwt() is null);
  v_ator text;
  v_gestao boolean;
  v_bloqueio text;
  v_motivo text;
  v_descarte jsonb := '{}'::jsonb;
  v_resp text;
  v_status_novo text;
begin
  if v_sem_jwt then
    v_ator   := lower(coalesce(p_ator, ''));
    v_gestao := coalesce(p_gestao, false);
  else
    v_ator   := public.app_email();
    v_gestao := public.usuario_e_gestao();
  end if;

  if v_ator = '' then
    return jsonb_build_object('ok', false, 'erro', 'sem_sessao');
  end if;

  select * into v_acao from public.acoes_desfazer where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'acao_nao_encontrada');
  end if;

  -- De onde a ficha está voltando. Lido ANTES de qualquer escrita e vale para
  -- os três tipos -- é isso que interessa no histórico, não o estado interno
  -- que o termo ou o link passam a ter.
  select status_atual into v_status_novo from public.alunos where id = v_acao.aluno_id;

  if not v_gestao and v_acao.operador_email <> v_ator then
    return jsonb_build_object('ok', false, 'erro', 'nao_e_sua');
  end if;

  -- Gestão desfazendo ação de outro precisa dizer por quê: é ela que responde
  -- pelo histórico depois.
  v_motivo := nullif(btrim(coalesce(p_motivo, '')), '');
  if v_gestao and v_acao.operador_email <> v_ator and v_motivo is null then
    return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio');
  end if;

  v_bloqueio := public._desfazer_bloqueio(v_acao, v_gestao);
  if v_bloqueio is not null then
    return jsonb_build_object('ok', false, 'erro', v_bloqueio);
  end if;

  -- --- Neutraliza o item na fila do outro lado ---------------------------
  if v_acao.tipo = 'TERMO_ENVIADO' then
    update public.termos_acordo
       set status = 'TERMO_DESFEITO_OPERADOR',
           observacao_adm = 'Desfeito por ' || v_ator ||
                            coalesce(' — ' || v_motivo, '') || '.',
           atualizado_em = now()
     where id = v_acao.referencia_id
       and status = 'TERMO_ENVIADO_ADM';
    if not found then
      return jsonb_build_object('ok', false, 'erro', 'termo_ja_tratado');
    end if;

    -- Documento na ficha errada é vazamento: sai do bucket, fica só o registro
    -- do descarte (nome, caminho, quem e por quê) em termo_arquivos_descartados.
    v_descarte := public._termo_descartar_vias(
      v_acao.referencia_id, v_ator,
      'Envio desfeito' || coalesce(' — ' || v_motivo, '') || '.'
    );

  elsif v_acao.tipo = 'LINK_SOLICITADO' then
    update public.links_pagamento
       set status = 'CANCELADO',
           cancelado_em = now(),
           observacao_adm = 'Solicitação desfeita por ' || v_ator ||
                            coalesce(' — ' || v_motivo, '') || '.',
           atualizado_em = now()
     where id = v_acao.referencia_id
       and status = 'SOLICITADO_LINK';
    if not found then
      return jsonb_build_object('ok', false, 'erro', 'link_ja_em_atendimento');
    end if;

    insert into public.historico_links_pagamento
      (link_id, aluno_id, aluno_nome, status_anterior, status_novo, descricao, usuario_email)
    values
      (v_acao.referencia_id, v_acao.aluno_id::text, v_acao.aluno_nome,
       'SOLICITADO_LINK', 'CANCELADO',
       'Solicitação desfeita pelo operador antes de o ADM assumir' ||
         coalesce(' — ' || v_motivo, '') || '.', v_ator);
  end if;

  -- --- Tira o crédito de acionamento do erro -----------------------------
  --     A linha continua no histórico: só deixa de ser tipo que conta.
  if v_acao.movimentacao_id is not null then
    update public.aluno_movimentacoes
       set tipo = 'FINALIZACAO_ATENDIMENTO_DESFEITA',
           descricao = coalesce(descricao, '') || ' [DESFEITO por ' || v_ator || ']'
     where id = v_acao.movimentacao_id
       and tipo = 'FINALIZACAO_ATENDIMENTO';
  end if;

  -- --- Devolve o caso a quem era ------------------------------------------
  --     Só quando foi a própria ação que pegou o caso solto e ninguém mexeu
  --     nele desde então. set_resp_aluno zera retorno/próxima ação ao trocar de
  --     dono, por isso vem ANTES da restauração da ficha.
  if v_acao.atribuiu_responsavel then
    select responsavel_atual_email into v_resp from public.alunos where id = v_acao.aluno_id;
    if lower(coalesce(v_resp,'')) = v_acao.operador_email then
      perform internal.set_resp_aluno(
        v_acao.aluno_id, null, null, 'ALTERACAO_OPERADOR',
        'Caso devolvido para a fila: a ação que o vinculou foi desfeita.',
        v_ator, v_ator);
    end if;
  end if;

  -- --- Restaura a ficha ----------------------------------------------------
  perform public._desfazer_restaurar_aluno(v_acao.aluno_id, v_acao.estado_anterior);

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em)
  values
    (v_acao.aluno_id::text, 'ACAO_DESFEITA',
     'Desfeito: ' || v_acao.rotulo || coalesce(' — ' || v_motivo, '') || '.',
     v_status_novo, v_acao.estado_anterior->>'status_atual',
     coalesce(v_acao.operador_nome, v_ator), v_ator, now());

  update public.acoes_desfazer
     set desfeito_em = now(),
         desfeito_por = v_ator,
         motivo = v_motivo,
         resultado = jsonb_build_object('descarte', v_descarte)
   where id = p_id;

  return jsonb_build_object(
    'ok', true,
    'tipo', v_acao.tipo,
    'aluno_id', v_acao.aluno_id,
    'status_restaurado', v_acao.estado_anterior->>'status_atual',
    'itens', coalesce(v_descarte->'itens', '[]'::jsonb)
  );
end;
$$;

-- 9) Expurgo ----------------------------------------------------------------
--    30 dias: passado isso o cartão já não desfaz nada (o item saiu da fila) e
--    a foto só ocupa espaço. O histórico do que foi desfeito continua em
--    aluno_movimentacoes, que ninguém expurga.
create or replace function public.desfazer_expurgar()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_cartoes int; v_fotos int;
begin
  delete from public.acoes_desfazer where criado_em < now() - interval '30 days';
  get diagnostics v_cartoes = row_count;
  delete from public.alunos_estado_anterior where criado_em < now() - interval '30 days';
  get diagnostics v_fotos = row_count;
  return jsonb_build_object('cartoes', v_cartoes, 'fotos', v_fotos);
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('desfazer_expurgar')
      where exists (select 1 from cron.job where jobname = 'desfazer_expurgar');
    perform cron.schedule('desfazer_expurgar', '20 4 * * *', 'select public.desfazer_expurgar();');
  end if;
end $$;

-- 10) Permissões ------------------------------------------------------------
--     Listar e desfazer: o operador chama direto (o gate de dono e de estado
--     vive dentro das próprias funções).
revoke all on function public.desfazer_listar(uuid, int) from public, anon;
grant execute on function public.desfazer_listar(uuid, int) to authenticated;
revoke all on function public.desfazer_acao(uuid, text, text, boolean) from public, anon;
grant execute on function public.desfazer_acao(uuid, text, text, boolean) to authenticated;

--     Internas: NUNCA pelo cliente. Só as de cima (SECURITY DEFINER) e o cron
--     as alcançam. Repare no `authenticated` explícito -- revogar só de
--     `public, anon` deixaria _desfazer_restaurar_aluno aberto a qualquer
--     operador logado, e ela sobrescreve a ficha de QUALQUER aluno.
revoke all on function public._desfazer_bloqueio(public.acoes_desfazer, boolean) from public, anon, authenticated;
revoke all on function public._desfazer_restaurar_aluno(uuid, jsonb) from public, anon, authenticated;
revoke all on function public._aluno_estado_json(public.alunos) from public, anon, authenticated;
revoke all on function public.desfazer_expurgar() from public, anon, authenticated;
grant execute on function public.desfazer_expurgar() to service_role;
