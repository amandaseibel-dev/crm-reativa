-- ============================================================================
-- Diretoria não recebe notificação nenhuma (2026-08-25)
-- ============================================================================
-- Varredura pedida pela Amanda: o perfil "diretoria" (leitura executiva —
-- Visão Executiva, DRE, Panorama 360 e relatório 2026/1) NÃO podia receber
-- aviso de operação. Estava recebendo.
--
-- O QUE ACHAMOS
-- _trg_whatsapp_notificar_mensagem(): quando chega mensagem de aluno numa
-- conversa SEM responsável, o aviso é distribuído para
-- "FROM public.usuarios u WHERE u.ativo" — ou seja, TODO usuário ativo,
-- diretoria inclusive. Em produção isso rendeu 28 notificações para
-- angela.ferreira@aelbra.com.br (20 ainda não lidas) entre 19/08 e 24/08,
-- todas do tipo WHATSAPP_MENSAGEM.
--
-- Além de ser recado que não é dela, o pop-up levava nome do aluno e os
-- primeiros 90 caracteres da mensagem — dado individual num perfil que só
-- deve ver consolidado — e o clique mandava para /central-whatsapp, rota que
-- a diretoria nem tem permissão de abrir.
--
-- O QUE ESTA MIGRATION FAZ
--   1. Tira a diretoria do leque do WhatsApp "sem responsável" (a origem).
--   2. Põe uma trava geral na tabela notificacoes: qualquer remetente, hoje ou
--      amanhã, que enderece uma notificação à diretoria tem a linha descartada
--      em silêncio. É a regra "diretoria não recebe notificação" escrita uma
--      vez só, em vez de repetida em cada gatilho novo.
--   3. Marca como lidas as notificações que já tinham chegado, para o sino e o
--      pop-up pararem hoje. NÃO apaga: o histórico fica para auditoria.
--
-- O que NÃO muda: quem tem responsável continua avisando só o responsável;
-- os alertas de canal fora do ar continuam indo para a allowlist de gestão
-- (amanda.seibel / cobranca04 / cobranca07), que já não incluía a diretoria.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Origem: leque do WhatsApp sem responsável
-- ----------------------------------------------------------------------------
-- Corpo IDÊNTICO ao de produção; muda só o WHERE do SELECT do "ELSE".
create or replace function public._trg_whatsapp_notificar_mensagem()
returns trigger language plpgsql security definer set search_path = public as $function$
DECLARE
  v_conv public.whatsapp_conversas%ROWTYPE;
  v_quem text; v_titulo text; v_previa text;
BEGIN
  IF new.direcao <> 'ENTRADA' OR coalesce(new.origem, '') = 'SYNC_INICIAL' THEN
    RETURN new;
  END IF;

  SELECT * INTO v_conv FROM public.whatsapp_conversas WHERE id = new.conversa_id;
  IF NOT FOUND THEN RETURN new; END IF;

  IF EXISTS (
    SELECT 1 FROM public.notificacoes n
    WHERE n.tipo = 'WHATSAPP_MENSAGEM' AND n.lida = false
      AND n.url_destino = '/central-whatsapp'
      AND n.mensagem LIKE '%' || v_conv.telefone_e164 || '%'
  ) THEN
    RETURN new;
  END IF;

  v_quem := coalesce(nullif(v_conv.aluno_nome,''), nullif(v_conv.nome_perfil,''), v_conv.telefone_e164);
  v_titulo := '💬 ' || v_quem;
  v_previa := left(coalesce(nullif(btrim(new.texto), ''), '[' || coalesce(new.tipo,'anexo') || ']'), 90);

  IF v_conv.responsavel_email IS NOT NULL THEN
    INSERT INTO public.notificacoes (usuario_destino_email, usuario_destino_nome, tipo,
                                     titulo, mensagem, url_destino, lida, criado_em)
    VALUES (lower(v_conv.responsavel_email), v_conv.responsavel_nome, 'WHATSAPP_MENSAGEM',
            v_titulo, v_previa || ' — ' || v_conv.telefone_e164, '/central-whatsapp', false, now());
  ELSE
    INSERT INTO public.notificacoes (usuario_destino_email, usuario_destino_nome, tipo,
                                     titulo, mensagem, url_destino, lida, criado_em)
    SELECT lower(u.email), u.nome, 'WHATSAPP_MENSAGEM',
           v_titulo || ' (sem responsável)',
           v_previa || ' — ' || v_conv.telefone_e164, '/central-whatsapp', false, now()
    FROM public.usuarios u
    -- Diretoria fora do leque: perfil de leitura executiva não atende Central.
    WHERE u.ativo AND coalesce(u.perfil, '') <> 'diretoria';
  END IF;

  RETURN new;
END; $function$;

comment on function public._trg_whatsapp_notificar_mensagem() is
  'Avisa o operador quando chega mensagem do aluno. Sem responsável, avisa todo usuário ativo MENOS a diretoria. Histórico importado nunca notifica.';

-- ----------------------------------------------------------------------------
-- 2. Trava geral: nada endereçado à diretoria entra em notificacoes
-- ----------------------------------------------------------------------------
-- BEFORE INSERT devolvendo NULL descarta a linha sem erro: quem notifica não
-- precisa saber quem é diretoria, e um gatilho novo (ou uma rotina de fora)
-- não reabre o furo por esquecimento. O descarte é silencioso de propósito --
-- notificação é aviso, não transação: abortar com exceção derrubaria a
-- gravação da mensagem/termo que gerou o aviso.
create or replace function public._notificacoes_diretoria_nao_recebe()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(coalesce(new.usuario_destino_email, ''))
      and u.perfil = 'diretoria'
  ) then
    return null; -- descarta em silêncio
  end if;
  return new;
end; $$;

comment on function public._notificacoes_diretoria_nao_recebe() is
  'Trava única da regra "diretoria não recebe notificação": descarta em silêncio qualquer insert endereçado a usuário com perfil diretoria.';

drop trigger if exists trg_notificacoes_diretoria_nao_recebe on public.notificacoes;
create trigger trg_notificacoes_diretoria_nao_recebe
  before insert on public.notificacoes
  for each row
  execute function public._notificacoes_diretoria_nao_recebe();

-- ----------------------------------------------------------------------------
-- 3. Silenciar o que já chegou (sem apagar)
-- ----------------------------------------------------------------------------
update public.notificacoes n
set lida = true, lida_em = coalesce(n.lida_em, now())
where n.lida is false
  and exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(n.usuario_destino_email)
      and u.perfil = 'diretoria'
  );
