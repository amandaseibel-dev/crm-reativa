-- Status de entrega de verdade: "aceita pelo WhatsApp" nao e "entregue".
--
-- O PROBLEMA: o status de saida era gravado uma unica vez, quando a mensagem
-- entrava na fila do gateway, e nunca mais mudava. Em producao existiam tres
-- valores: null (ENTRADA), ENVIADO (1.075 SAIDA) e FALHOU (2). O operador lia
-- "ENVIADO" como "o aluno recebeu" — e nao era: significava apenas "nos
-- enfileiramos". Nenhuma das 1.075 tinha confirmacao de entrega por tras.
--
-- O QUE A INSTRUMENTACAO PROVOU nesta sessao (19/08/2026, trafego real, sem
-- envio de teste): o Baileys entrega os acks por `messages.update`, com o campo
-- `status` sozinho, nos valores do enum `proto.WebMessageInfo.Status`:
--   2 SERVER_ACK   -> o WhatsApp aceitou      (0,5s apos o envio)
--   3 DELIVERY_ACK -> chegou no aparelho      (4,9s apos o envio)
--   4 READ         -> o destinatario abriu
-- `message-receipt.update` nao disparou nenhuma vez nesta sessao.
--
-- POR QUE A TRANSICAO PRECISA SER MONOTONICA: DELIVERY_ACK e READ chegaram com
-- 10 MILISSEGUNDOS de diferenca. Nessa janela a ordem de chegada pode inverter,
-- e sem trava uma mensagem ja lida voltaria para "entregue" na tela do
-- operador. Regressao de status e pior do que status atrasado: destroi a
-- confianca no indicador inteiro.

-- ---------------------------------------------------------------------------
-- 1. Carimbos por marco. Guardar so o status perderia QUANDO cada coisa
--    aconteceu — e "entregue ha 2 segundos" e "entregue ha 3 dias" sao
--    informacoes operacionais muito diferentes.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_mensagens
  add column if not exists aceita_em    timestamptz,
  add column if not exists entregue_em  timestamptz,
  add column if not exists lida_em      timestamptz,
  add column if not exists falhou_em    timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Vocabulario novo e conversao do antigo.
--
--    ENVIADO -> ACEITA_PELO_WHATSAPP, e nao ENTREGUE. As 1.075 mensagens
--    antigas tem wamid, entao o WhatsApp de fato as aceitou; mas ninguem nunca
--    escutou ack de entrega para elas. Chamar isso de "entregue" seria repetir
--    a mentira que este arquivo existe para corrigir. Elas ficam com 1 tique, e
--    e a verdade: aceitas, entrega nunca confirmada.
-- ---------------------------------------------------------------------------
update public.whatsapp_mensagens
   set status = 'ACEITA_PELO_WHATSAPP'
 where direcao = 'SAIDA' and status = 'ENVIADO';

update public.whatsapp_mensagens
   set falhou_em = coalesce(falhou_em, criado_em)
 where direcao = 'SAIDA' and status = 'FALHOU';

alter table public.whatsapp_mensagens
  drop constraint if exists ck_whatsapp_msg_status;

alter table public.whatsapp_mensagens
  add constraint ck_whatsapp_msg_status check (
    status is null or status in (
      'PENDENTE',              -- ainda tentando enviar
      'ACEITA_PELO_WHATSAPP',  -- sendMessage devolveu wamid / SERVER_ACK
      'ENTREGUE',              -- DELIVERY_ACK: chegou no aparelho
      'LIDA',                  -- READ: o destinatario abriu
      'FALHOU'                 -- erro confirmado
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Ordem do progresso. FALHOU fica FORA da escala de proposito: nao e "menos
--    que entregue", e um desvio. Sai da escala e volta por regra propria.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_status_ordem(p_status text)
returns int
language sql
immutable
as $$
  select case p_status
    when 'PENDENTE'             then 1
    when 'ACEITA_PELO_WHATSAPP' then 2
    when 'ENTREGUE'             then 3
    when 'LIDA'                 then 4
    else 0                       -- FALHOU e null
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Aplicacao do ack, correlacionada EXCLUSIVAMENTE por wamid (que e UNIQUE).
--
--    Devolve o status resultante para o gateway poder registrar o que de fato
--    valeu — inclusive quando o ack foi ignorado por ser regressivo.
--
--    REGRAS:
--    - so mexe em SAIDA. Ack de mensagem recebida nao existe;
--    - nunca regride na escala: um DELIVERY_ACK atrasado nao rebaixa uma
--      mensagem ja LIDA;
--    - FALHOU so entra a partir de PENDENTE/ACEITA. Uma mensagem ja entregue
--      ou lida nao "falha" depois — se chegou, chegou;
--    - de FALHOU se SAI com prova de entrega (ENTREGUE/LIDA): o ack de entrega
--      e evidencia mais forte do que o erro anterior;
--    - carimbo so e gravado na primeira vez (coalesce): reenvio de ack nao
--      reescreve a hora original;
--    - wamid desconhecido nao e erro. Ack pode chegar para mensagem que este
--      processo nunca viu (reinicio do gateway, mensagem enviada pelo celular).
--      Devolve null e o gateway registra sem alarde.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_mensagem_ack(
  p_wamid  text,
  p_status text,
  p_em     timestamptz default now()
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_atual text;
  v_novo  text;
  v_em    timestamptz := coalesce(p_em, now());
begin
  if p_wamid is null or p_status is null then
    return null;
  end if;

  select status into v_atual
    from public.whatsapp_mensagens
   where wamid = p_wamid and direcao = 'SAIDA'
   for update;

  if not found then
    return null; -- ack de mensagem que nao conhecemos: silencioso de proposito
  end if;

  if p_status = 'FALHOU' then
    -- Ja chegou no aparelho? Entao nao falhou. Ignora.
    if public.whatsapp_status_ordem(v_atual) >= public.whatsapp_status_ordem('ENTREGUE') then
      return v_atual;
    end if;
    v_novo := 'FALHOU';
  elsif public.whatsapp_status_ordem(p_status) <= public.whatsapp_status_ordem(v_atual)
        and v_atual is distinct from 'FALHOU' then
    -- Ack regressivo ou repetido: mantem o que ja havia, mas deixa o carimbo
    -- ser preenchido abaixo (um DELIVERY atrasado ainda informa QUANDO
    -- entregou, mesmo que o status ja esteja em LIDA).
    v_novo := v_atual;
  else
    v_novo := p_status;
  end if;

  update public.whatsapp_mensagens
     set status      = v_novo,
         aceita_em   = case when p_status = 'ACEITA_PELO_WHATSAPP' then coalesce(aceita_em, v_em)   else aceita_em   end,
         entregue_em = case when p_status = 'ENTREGUE'             then coalesce(entregue_em, v_em) else entregue_em end,
         lida_em     = case when p_status = 'LIDA'                 then coalesce(lida_em, v_em)     else lida_em     end,
         falhou_em   = case when v_novo   = 'FALHOU'               then coalesce(falhou_em, v_em)   else falhou_em   end
   where wamid = p_wamid and direcao = 'SAIDA';

  return v_novo;
end;
$$;

revoke all on function public.whatsapp_mensagem_ack(text, text, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. A Central le os carimbos junto com o status. Sem isto o tique existe mas
--    o operador nao consegue saber de quando e.
-- ---------------------------------------------------------------------------
drop function if exists public.whatsapp_mensagens_listar(uuid, integer);

create or replace function public.whatsapp_mensagens_listar(
  p_conversa_id uuid,
  p_limite integer default 200
)
returns table (
  id uuid, direcao text, tipo text, texto text, midia_id text, midia_mime text,
  status text, erro_detalhe text, enviado_por_email text, origem text,
  timestamp_wa timestamptz, midia_path text, midia_nome text,
  midia_tamanho bigint, midia_erro text,
  aceita_em timestamptz, entregue_em timestamptz, lida_em timestamptz, falhou_em timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $$
  SELECT m.id, m.direcao, m.tipo, m.texto, m.midia_id, m.midia_mime,
         m.status, m.erro_detalhe, m.enviado_por_email, m.origem, m.timestamp_wa,
         m.midia_path, m.midia_nome, m.midia_tamanho, m.midia_erro,
         m.aceita_em, m.entregue_em, m.lida_em, m.falhou_em
  FROM public.whatsapp_mensagens m
  WHERE public.app_usuario_ativo() AND m.conversa_id = p_conversa_id
  ORDER BY m.timestamp_wa DESC
  LIMIT greatest(1, least(coalesce(p_limite, 200), 500));
$$;

grant execute on function public.whatsapp_mensagens_listar(uuid, integer) to authenticated;
