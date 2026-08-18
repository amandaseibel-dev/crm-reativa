-- Central WhatsApp — 2 números, 1 central — conexão por QR Code (Baileys)
-- =============================================================================
-- OBJETIVO: receber no CRM as mensagens que chegam nos DOIS números da operação
-- e permitir que ~11 operadores atendam de dentro do ReATIVA One, com o login
-- que já têm. Nenhum operador escaneia QR, abre WhatsApp Web ou compartilha
-- sessão: a conexão pertence ao SERVIDOR, não à pessoa.
--
-- ARQUITETURA:
--   WhatsApp -> microserviço de espelho (Node + Baileys, VPS/Docker, 24/7)
--            -> Edge Function (HMAC) -> estas tabelas -> Central do ReATIVA One
--
-- CENTRAL ÚNICA: não existe "Central 01" e "Central 02". O número que recebeu é
-- a COLUNA `canal_id` da conversa, nunca uma tela separada. Filtrar por número é
-- opção de visualização.
--
-- O QUE MUDOU EM RELAÇÃO AO DESENHO ANTERIOR (Cloud API oficial da Meta):
--   - `phone_number_id` (id do número na Meta) virou `sessao_chave` (id do
--     canal no nosso gateway). É a única identidade de canal que existe agora.
--   - A JANELA DE 24H DEIXOU DE EXISTIR. Ela era regra de tarifação da Meta.
--     No caminho QR não há template, não há custo por conversa e não há prazo
--     para responder. Todas as colunas e funções de janela/template saíram.
--   - O webhook não valida mais assinatura da Meta: valida HMAC do NOSSO
--     gateway, com segredo compartilhado.
--
-- O QUE FOI MANTIDO INTEIRO (é independente de quem entrega a mensagem):
--   conversa única por (canal, telefone), mensagem idempotente por id,
--   "sem retorno" derivado por trigger, retenção LGPD de 12 meses.
--
-- VÍNCULO COM A FICHA DO ALUNO (decisão Amanda 2026-08-18): a Central passa a
-- identificar o aluno pelo telefone. A identificação é LEVE e roda UMA VEZ, na
-- criação da conversa — grava id e nome na própria conversa. A tela nunca
-- consulta a base por linha listada, e a ficha completa só é carregada quando o
-- operador abre a conversa. Ambiguidade JAMAIS vira palpite: vira pendência de
-- vínculo manual.
--
-- SEGURANÇA (LGPD): mensagens contêm PII. RLS ligada em tudo. O gateway NÃO tem
-- credencial de banco — fala só com a Edge Function, por HMAC. As credenciais
-- da sessão do WhatsApp ficam em tabela deny-all, acessível apenas por
-- service_role. Escrita sempre por service_role ou RPC SECURITY DEFINER.
--
-- Idempotente. Confirmado em 2026-08-18 que NUNCA foi aplicada: nem em produção
-- (ahattpqrjmhkzsmnbdzs) nem em staging (edlzlfbstshojxrudwaa) existe qualquer
-- tabela `whatsapp_*`, e a versão 20260817120000 não consta em
-- supabase_migrations.schema_migrations dos dois. Por isso o arquivo original
-- foi reescrito em vez de receber migrations incrementais.
-- =============================================================================

------------------------------------------------------------------------------
-- 1) Canais = os nossos 2 números, e o estado da conexão de cada um.
--
--    `sessao_chave` é o identificador único do canal no gateway ("cobranca",
--    "comercial"). É o que amarra a sessão do Baileys a esta linha. O gateway
--    nunca inventa canal: se chegar mensagem de uma sessão desconhecida, o
--    registro falha alto em vez de criar canal fantasma.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_canais (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_chave          text        NOT NULL,          -- id do canal no gateway
  display_phone_number  text        NOT NULL,          -- número legível, ex. +55 51 9...
  apelido               text        NOT NULL,          -- como a operação chama ("Cobrança", "Comercial")
  ativo                 boolean     NOT NULL DEFAULT true,

  -- Estado da conexão, reportado pelo gateway. A tela mostra isto; a gestão age
  -- a partir disto. Nada aqui é editado por operador.
  conexao_status        text        NOT NULL DEFAULT 'DESCONECTADO',
  conexao_detalhe       text,
  conexao_atualizada_em timestamptz NOT NULL DEFAULT now(),
  conectado_em          timestamptz,
  jid_conectado         text,                          -- número que de fato pareou
  ultimo_heartbeat_em   timestamptz,

  -- QR corrente. NÃO é exposto na RPC dos operadores: só a gestão vê, por RPC
  -- própria, e a leitura fica registrada. QR é credencial de acesso ao número.
  qr_code               text,
  qr_expira_em          timestamptz,

  -- Sincronização inicial: uma vez por número, no primeiro pareamento. Depois
  -- de concluída, não se repete (o WhatsApp não reenvia histórico).
  sync_inicial_em       timestamptz,

  criado_em             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_whatsapp_canal_conexao CHECK (conexao_status IN (
    'DESCONECTADO','CONECTANDO','AGUARDANDO_QR','CONECTADO','ERRO','PAREAMENTO_NECESSARIO'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_whatsapp_canais_sessao_chave
  ON public.whatsapp_canais (sessao_chave);

COMMENT ON TABLE public.whatsapp_canais IS
  'Os numeros da operacao e o estado da conexao QR de cada um. sessao_chave amarra a sessao do gateway a esta linha. qr_code e credencial: so gestao le, via RPC que registra a leitura.';

------------------------------------------------------------------------------
-- 2) Credenciais da sessão do WhatsApp.
--
--    POR QUE NO BANCO E NÃO EM ARQUIVO: `useMultiFileAuthState` do Baileys é
--    exemplo de documentação, não solução de produção — some quando o container
--    é recriado, não sobrevive a troca de máquina e não tem backup. Perder isto
--    significa reparear o número na mão, e reparear significa perder para
--    sempre a chance da sincronização inicial daquele número.
--
--    DENY-ALL: nenhuma policy. Só service_role (a Edge Function) enxerga. Este
--    é o dado mais sensível do módulo — quem tem isto tem o WhatsApp.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_sessao_credenciais (
  sessao_chave  text        NOT NULL,
  tipo          text        NOT NULL,   -- 'creds' | 'app-state-sync-key' | 'pre-key' | ...
  chave         text        NOT NULL,   -- id dentro do tipo ('creds' quando único)
  dado          jsonb       NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sessao_chave, tipo, chave)
);

COMMENT ON TABLE public.whatsapp_sessao_credenciais IS
  'Auth state do Baileys por sessao. Substitui useMultiFileAuthState: sobrevive a recriacao do container e a troca de VPS. DENY-ALL - so service_role.';

------------------------------------------------------------------------------
-- 3) Conversas. UMA por (canal, telefone de quem escreveu): se a mesma pessoa
--    escrever para os dois números, são duas conversas — e cada resposta sai
--    pelo número que ela procurou.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_conversas (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  canal_id               uuid        NOT NULL REFERENCES public.whatsapp_canais(id),
  telefone_e164          text        NOT NULL,          -- só dígitos, ex. 5551999998888
  nome_perfil            text,                          -- nome que a pessoa usa no WhatsApp

  status                 text        NOT NULL DEFAULT 'NOVO',  -- NOVO|EM_ATENDIMENTO|RESPONDIDO|ENCERRADO
  nao_lidas              integer     NOT NULL DEFAULT 0,

  -- RESPONSÁVEL — evita dois operadores respondendo o mesmo aluno.
  -- O nome fica desnormalizado de propósito: a lista da central não pode fazer
  -- join com `usuarios` a cada linha só para escrever uma etiqueta.
  responsavel_email      text,
  responsavel_nome       text,
  responsavel_desde      timestamptz,

  -- IDENTIFICAÇÃO LEVE DO ALUNO — resolvida na criação da conversa e gravada
  -- aqui. A listagem lê estas colunas; NÃO consulta `alunos`.
  --   IDENTIFICADO   = uma correspondência inequívoca
  --   AMBIGUO        = mais de um aluno com o mesmo telefone -> vínculo manual
  --   NAO_ENCONTRADO = nenhum aluno com esse telefone (estado VÁLIDO, não erro)
  --   MANUAL         = alguém da operação vinculou à mão
  aluno_id               uuid        REFERENCES public.alunos(id) ON DELETE SET NULL,
  aluno_nome             text,
  aluno_status           text        NOT NULL DEFAULT 'NAO_ENCONTRADO',
  aluno_candidatos       jsonb,                         -- só quando AMBIGUO
  aluno_identificado_em  timestamptz,

  ultima_mensagem_em     timestamptz,
  ultima_mensagem_previa text,

  -- SEM RETORNO — o dado mais importante desta tabela.
  -- A operação não sabe quem está esperando porque isso vive na cabeça de quem
  -- atendeu e em milhares de conversas no aparelho. Aqui é DERIVADO: se a
  -- última mensagem da conversa é de quem escreveu, está sem retorno. Mantido
  -- por TRIGGER (item 13), nunca por alguém marcar status à mão — status que
  -- depende de memória humana é status que mente.
  aguardando_resposta    boolean     NOT NULL DEFAULT false,
  aguardando_desde       timestamptz,   -- desde quando espera (ordena a fila)

  -- Veio da sincronização inicial do pareamento (histórico do aparelho), não do
  -- tempo real. Separa "pendência antiga que resgatamos" de "conversa nova".
  origem_sync            boolean     NOT NULL DEFAULT false,

  criado_em              timestamptz NOT NULL DEFAULT now(),
  atualizado_em          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_whatsapp_conversa UNIQUE (canal_id, telefone_e164),
  CONSTRAINT ck_whatsapp_conversa_status
    CHECK (status IN ('NOVO','EM_ATENDIMENTO','RESPONDIDO','ENCERRADO')),
  CONSTRAINT ck_whatsapp_conversa_aluno_status
    CHECK (aluno_status IN ('IDENTIFICADO','AMBIGUO','NAO_ENCONTRADO','MANUAL'))
);

COMMENT ON TABLE public.whatsapp_conversas IS
  'Conversa por (numero nosso, telefone de quem escreveu). aluno_id/aluno_nome sao cache da identificacao leve por telefone - a listagem nunca consulta alunos.';

CREATE INDEX IF NOT EXISTS ix_whatsapp_conversas_ordem
  ON public.whatsapp_conversas (ultima_mensagem_em DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS ix_whatsapp_conversas_status  ON public.whatsapp_conversas (status);
CREATE INDEX IF NOT EXISTS ix_whatsapp_conversas_canal   ON public.whatsapp_conversas (canal_id);
CREATE INDEX IF NOT EXISTS ix_whatsapp_conversas_tel     ON public.whatsapp_conversas (telefone_e164);
CREATE INDEX IF NOT EXISTS ix_whatsapp_conversas_aluno   ON public.whatsapp_conversas (aluno_id)
  WHERE aluno_id IS NOT NULL;

-- Filtro "minhas conversas" — parcial, só as que têm dono.
CREATE INDEX IF NOT EXISTS ix_whatsapp_conversas_responsavel
  ON public.whatsapp_conversas (responsavel_email)
  WHERE responsavel_email IS NOT NULL;

-- Índice da fila que importa: quem está esperando, o mais antigo primeiro.
-- Parcial, então só indexa as que aguardam — fica pequeno mesmo com milhares
-- de conversas encerradas.
CREATE INDEX IF NOT EXISTS ix_whatsapp_conversas_aguardando
  ON public.whatsapp_conversas (aguardando_desde ASC)
  WHERE aguardando_resposta;

------------------------------------------------------------------------------
-- 4) Mensagens. `wamid` UNIQUE é a idempotência.
--
--    Ela protege TRÊS caminhos que se sobrepõem: reentrega do gateway após
--    falha de rede, o eco da própria mensagem que enviamos (o Baileys devolve
--    o que sai como `fromMe`) e a sincronização inicial trazendo mensagem que
--    já tínhamos. Sem essa trava a conversa duplica sozinha.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_mensagens (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id      uuid        NOT NULL REFERENCES public.whatsapp_conversas(id) ON DELETE CASCADE,
  wamid            text        UNIQUE,             -- id da mensagem no WhatsApp
  direcao          text        NOT NULL,           -- ENTRADA | SAIDA
  tipo             text        NOT NULL DEFAULT 'text',
  texto            text,

  -- Mídia: a fase 1 guarda a referência e o tipo. O download para bucket
  -- privado entra depois — o que não pode faltar agora é o registro de que
  -- existiu mídia, para o operador saber que a pessoa mandou algo.
  midia_id         text,
  midia_mime       text,
  midia_path       text,

  status           text,                            -- ENVIADO|ENTREGUE|LIDO|FALHOU
  erro_detalhe     text,
  enviado_por_email text,                           -- operador do CRM; NULO na entrada
                                                    -- e nas saídas feitas do celular
  -- TEMPO_REAL = chegou pela sessão ligada
  -- SYNC_INICIAL = veio do histórico do aparelho no pareamento
  origem           text        NOT NULL DEFAULT 'TEMPO_REAL',
  timestamp_wa     timestamptz NOT NULL,
  payload          jsonb,
  criado_em        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_whatsapp_msg_direcao CHECK (direcao IN ('ENTRADA','SAIDA')),
  CONSTRAINT ck_whatsapp_msg_origem  CHECK (origem  IN ('TEMPO_REAL','SYNC_INICIAL'))
);

CREATE INDEX IF NOT EXISTS ix_whatsapp_mensagens_conversa
  ON public.whatsapp_mensagens (conversa_id, timestamp_wa);

------------------------------------------------------------------------------
-- 5) Log bruto do que o gateway entregou: a caixa-preta, para auditoria e
--    reprocessamento. Tem expurgo (item 10) para não virar peso morto.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_eventos (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recebido_em   timestamptz NOT NULL DEFAULT now(),
  assinatura_ok boolean     NOT NULL,
  processado    boolean     NOT NULL DEFAULT false,
  erro          text,
  payload       jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_whatsapp_webhook_eventos_data
  ON public.whatsapp_webhook_eventos (recebido_em DESC);

------------------------------------------------------------------------------
-- 6) Diário da conexão: cada mudança de estado, cada QR gerado, cada leitura de
--    QR pela gestão, cada logout. É o que permite responder "por que caiu?" e
--    "quem pareou este número?" depois do fato.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_conexao_eventos (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canal_id     uuid        REFERENCES public.whatsapp_canais(id) ON DELETE CASCADE,
  sessao_chave text,
  evento       text        NOT NULL,   -- CONECTADO|DESCONECTADO|QR_GERADO|QR_EXIBIDO|LOGOUT|ERRO|COMANDO
  detalhe      text,
  por_email    text,                   -- quando a ação partiu de alguém do CRM
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_whatsapp_conexao_eventos_data
  ON public.whatsapp_conexao_eventos (criado_em DESC);

------------------------------------------------------------------------------
-- 7) Sincronização inicial — o evento de uma chance só.
--
--    O WhatsApp entrega histórico ao dispositivo vinculado APENAS no momento do
--    pareamento, e o pedido posterior ("me manda o resto") é silenciosamente
--    ignorado para dispositivos companheiros. Ou seja: o que não for capturado
--    e gravado durante a sincronização, não volta.
--
--    Esta tabela existe para que a operação saiba o que foi resgatado, quanto,
--    e se deu certo — em vez de descobrir depois que faltou.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_sync_execucoes (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  canal_id             uuid        NOT NULL REFERENCES public.whatsapp_canais(id) ON DELETE CASCADE,
  status               text        NOT NULL DEFAULT 'EM_ANDAMENTO',  -- EM_ANDAMENTO|CONCLUIDA|FALHOU
  iniciado_em          timestamptz NOT NULL DEFAULT now(),
  concluido_em         timestamptz,
  lotes_recebidos      integer     NOT NULL DEFAULT 0,
  conversas_criadas    integer     NOT NULL DEFAULT 0,
  mensagens_importadas integer     NOT NULL DEFAULT 0,
  contatos_recebidos   integer     NOT NULL DEFAULT 0,
  pendencias_detectadas integer    NOT NULL DEFAULT 0,
  -- O Baileys sinaliza quando acredita ter mandado o último lote. É "acredita":
  -- por isso guardamos o sinal, mas a execução também fecha por inatividade.
  ultimo_lote_final    boolean     NOT NULL DEFAULT false,
  erro                 text,

  CONSTRAINT ck_whatsapp_sync_status CHECK (status IN ('EM_ANDAMENTO','CONCLUIDA','FALHOU'))
);

CREATE INDEX IF NOT EXISTS ix_whatsapp_sync_canal
  ON public.whatsapp_sync_execucoes (canal_id, iniciado_em DESC);

------------------------------------------------------------------------------
-- 8) Configuração da central. Linha única.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_config (
  id                        boolean     PRIMARY KEY DEFAULT true,
  -- Sem heartbeat por mais que isto, o canal é considerado fora do ar mesmo que
  -- o último status reportado diga "CONECTADO" — processo morto não avisa que
  -- morreu.
  minutos_sem_heartbeat_alerta integer  NOT NULL DEFAULT 5,
  atualizado_por_email      text,
  atualizado_em             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_whatsapp_config_linha_unica CHECK (id)
);

INSERT INTO public.whatsapp_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

------------------------------------------------------------------------------
-- 9) RLS. Deny-by-default em tudo. Escrita SEMPRE por service_role (gateway via
--    Edge Function) ou RPC SECURITY DEFINER — nenhuma policy de
--    INSERT/UPDATE/DELETE para o app.
--
--    A central é ÚNICA e compartilhada: qualquer usuário ATIVO do CRM lê
--    conversas e mensagens. Isso é proposital — a operação precisa ver o que
--    chega para poder assumir. O responsável organiza QUEM cuida, não quem vê.
------------------------------------------------------------------------------
ALTER TABLE public.whatsapp_canais              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversas           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_mensagens           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_webhook_eventos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conexao_eventos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_sync_execucoes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_config              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_sessao_credenciais  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_canais_leitura ON public.whatsapp_canais;
CREATE POLICY whatsapp_canais_leitura ON public.whatsapp_canais
  FOR SELECT TO authenticated
  USING (public.app_usuario_ativo());

DROP POLICY IF EXISTS whatsapp_conversas_leitura ON public.whatsapp_conversas;
CREATE POLICY whatsapp_conversas_leitura ON public.whatsapp_conversas
  FOR SELECT TO authenticated
  USING (public.app_usuario_ativo());

-- Leitura direta das mensagens é o que permite o Realtime funcionar na tela.
DROP POLICY IF EXISTS whatsapp_mensagens_leitura ON public.whatsapp_mensagens;
CREATE POLICY whatsapp_mensagens_leitura ON public.whatsapp_mensagens
  FOR SELECT TO authenticated
  USING (public.app_usuario_ativo());

-- Log bruto, credenciais, config e diário de conexão: deny-all para o app
-- (sem policy de SELECT). Chegam à tela por RPC, filtrados.
REVOKE ALL ON public.whatsapp_webhook_eventos    FROM anon, authenticated;
REVOKE ALL ON public.whatsapp_config             FROM anon, authenticated;
REVOKE ALL ON public.whatsapp_sessao_credenciais FROM anon, authenticated;
REVOKE ALL ON public.whatsapp_conexao_eventos    FROM anon, authenticated;
REVOKE ALL ON public.whatsapp_sync_execucoes     FROM anon, authenticated;

------------------------------------------------------------------------------
-- 10) Telefone: normalização e chave de comparação.
--
--     `whatsapp_normalizar_telefone` = chave estável da CONVERSA. Garante que o
--     mesmo telefone, em formatos diferentes, caia sempre na mesma conversa.
--
--     `whatsapp_chave_telefone` = chave de COMPARAÇÃO com a base de alunos, e é
--     onde mora a armadilha do nono dígito.
--
--     O celular brasileiro ganhou um 9 na frente; a base tem os dois formatos
--     misturados. Um telefone FIXO (começa com 2-5) que recebe um 9 na frente
--     vira o celular de OUTRA pessoa, e casa o aluno errado. Esse bug já foi
--     cometido aqui antes.
--
--     A saída é uma chave canônica: TUDO vira a forma de 11 dígitos do celular,
--     e o fixo é deixado em paz. A decisão é pelo terceiro dígito (o primeiro
--     depois do DDD):
--       11 dígitos começando em 9  -> já é celular, fica como está
--       10 dígitos com 6,7,8 ou 9  -> celular antigo, GANHA o 9
--       10 dígitos com 2,3,4 ou 5  -> FIXO, nunca ganha o 9
--
--     ATENÇÃO — por que não "os últimos 8 dígitos": essa versão foi tentada e
--     REPROVADA no teste contra o banco. O fixo 3333-4444 e o celular
--     9 3333-4444 têm os mesmos 8 dígitos finais e colapsavam na MESMA chave,
--     recriando de outro jeito a confusão que a função existe para evitar.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_normalizar_telefone(p_telefone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN d IS NULL OR length(d) < 10 THEN NULL
    WHEN left(d,2) = '55' AND length(d) IN (12,13) THEN d
    WHEN length(d) IN (10,11) THEN '55' || d
    ELSE d
  END
  FROM (SELECT nullif(regexp_replace(coalesce(p_telefone,''), '\D', '', 'g'), '') AS d) s;
$$;

COMMENT ON FUNCTION public.whatsapp_normalizar_telefone(text) IS
  'Chave estavel da conversa: mesmo telefone em formatos diferentes cai sempre na mesma conversa.';

CREATE OR REPLACE FUNCTION public.whatsapp_chave_telefone(p_telefone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  WITH bruto AS (
    SELECT nullif(regexp_replace(coalesce(p_telefone,''), '\D', '', 'g'), '') AS d
  ),
  local AS (
    -- tira o DDI e fica com DDD + numero
    SELECT CASE
      WHEN d IS NULL THEN NULL
      WHEN left(d,2) = '55' AND length(d) IN (12,13) THEN substr(d,3)
      WHEN length(d) IN (10,11) THEN d
      ELSE NULL
    END AS l
    FROM bruto
  )
  SELECT CASE
    WHEN l IS NULL THEN NULL
    -- ja e celular de 9 digitos: e a forma canonica
    WHEN length(l) = 11 AND substr(l,3,1) = '9' THEN l
    -- 8 digitos na faixa 6-9: celular antigo, recebe o nono digito
    WHEN length(l) = 10 AND substr(l,3,1) BETWEEN '6' AND '9' THEN left(l,2) || '9' || right(l,8)
    -- 8 digitos na faixa 2-5: FIXO. Nunca ganha o 9.
    ELSE l
  END
  FROM local;
$$;

COMMENT ON FUNCTION public.whatsapp_chave_telefone(text) IS
  'Chave canonica DDD+8 ultimos digitos para casar telefone com aluno sem cair na armadilha do nono digito (fixo nunca ganha 9).';

------------------------------------------------------------------------------
-- 11) Identificação LEVE do aluno pelo telefone.
--
--     Roda UMA VEZ, quando a conversa nasce (ou por pedido manual). Não roda a
--     cada mensagem e NUNCA na renderização da lista: o resultado fica gravado
--     na conversa. É essa gravação que segura a performance com 11 operadores
--     olhando a central ao mesmo tempo.
--
--     Procura nos três telefones que a base tem (do aluno e dos dois
--     responsáveis). Duas ou mais pessoas com o mesmo telefone => AMBIGUO, com
--     os candidatos guardados para o operador escolher. Palpite automático é
--     proibido: casar o aluno errado numa cobrança é pior do que não casar.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_identificar_aluno(p_telefone text)
RETURNS TABLE (
  aluno_id     uuid,
  aluno_nome   text,
  situacao     text,      -- IDENTIFICADO | AMBIGUO | NAO_ENCONTRADO
  candidatos   jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH chave AS (
    SELECT public.whatsapp_chave_telefone(p_telefone) AS k
  ),
  cand AS (
    -- Procura nos TRES telefones que a base tem: o do aluno e o dos dois
    -- responsaveis. O teto de 50 e so guarda-corpo contra telefone-lixo
    -- (0000000000) que casaria com meia base.
    SELECT a.id, coalesce(a.nome, a.nome_aluno) AS nome, a.matricula
    FROM public.alunos a
    CROSS JOIN chave c
    WHERE c.k IS NOT NULL
      AND (
        public.whatsapp_chave_telefone(a.telefone)       = c.k
        OR public.whatsapp_chave_telefone(a.telefone_resp1) = c.k
        OR public.whatsapp_chave_telefone(a.telefone_resp2) = c.k
      )
    LIMIT 50
  ),
  n AS (SELECT count(*)::integer AS qtd FROM cand)
  SELECT
    CASE WHEN n.qtd = 1 THEN (SELECT c.id   FROM cand c) END,
    CASE WHEN n.qtd = 1 THEN (SELECT c.nome FROM cand c) END,
    CASE WHEN n.qtd = 0 THEN 'NAO_ENCONTRADO'
         WHEN n.qtd = 1 THEN 'IDENTIFICADO'
         ELSE 'AMBIGUO' END,
    -- Ambiguo: ninguem e escolhido. Os candidatos ficam guardados para a tela
    -- oferecer a escolha ao operador. Palpite automatico e proibido - casar o
    -- aluno errado numa cobranca e pior do que nao casar.
    CASE WHEN n.qtd > 1 THEN (
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'matricula', c.matricula)
                       ORDER BY c.nome)
      FROM cand c
    ) END
  FROM n;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_identificar_aluno(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_identificar_aluno(text) TO authenticated;

------------------------------------------------------------------------------
-- 12) ENTRADA de mensagem (gateway -> Edge Function -> aqui).
--
--     Só service_role escreve. `p_origem` distingue tempo real de histórico
--     importado; a idempotência por `wamid` protege os dois.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_registrar_mensagem(
  p_sessao_chave    text,
  p_telefone        text,
  p_nome_perfil     text,
  p_wamid           text,
  p_direcao         text,        -- ENTRADA | SAIDA (SAIDA = enviada do celular ou por nós)
  p_tipo            text,
  p_texto           text,
  p_midia_id        text,
  p_midia_mime      text,
  p_timestamp       timestamptz,
  p_payload         jsonb,
  p_origem          text DEFAULT 'TEMPO_REAL',
  p_enviado_por     text DEFAULT NULL,
  p_status          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canal_id    uuid;
  v_conversa_id uuid;
  v_e164        text := public.whatsapp_normalizar_telefone(p_telefone);
  v_previa      text;
  v_ident       record;
  v_ts          timestamptz := coalesce(p_timestamp, now());
  v_sync        boolean := (coalesce(p_origem,'TEMPO_REAL') = 'SYNC_INICIAL');
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'whatsapp_registrar_mensagem: acesso negado' USING ERRCODE = '42501';
  END IF;

  IF p_direcao NOT IN ('ENTRADA','SAIDA') THEN
    RAISE EXCEPTION 'direcao invalida: %', p_direcao;
  END IF;

  SELECT id INTO v_canal_id
  FROM public.whatsapp_canais
  WHERE sessao_chave = p_sessao_chave;

  -- Canal desconhecido falha alto de propósito: melhor o gateway acusar erro do
  -- que criar um canal fantasma e espalhar conversa órfã pela central.
  IF v_canal_id IS NULL THEN
    RAISE EXCEPTION 'canal desconhecido para sessao %', p_sessao_chave;
  END IF;
  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'telefone invalido: %', p_telefone;
  END IF;

  SELECT id INTO v_conversa_id
  FROM public.whatsapp_conversas
  WHERE canal_id = v_canal_id AND telefone_e164 = v_e164;

  IF v_conversa_id IS NULL THEN
    -- Conversa nova: é AQUI, e só aqui, que a identificação do aluno roda.
    SELECT * INTO v_ident FROM public.whatsapp_identificar_aluno(v_e164);

    INSERT INTO public.whatsapp_conversas (
      canal_id, telefone_e164, nome_perfil, status,
      aluno_id, aluno_nome, aluno_status, aluno_candidatos, aluno_identificado_em,
      origem_sync
    ) VALUES (
      v_canal_id, v_e164, p_nome_perfil, 'NOVO',
      v_ident.aluno_id, v_ident.aluno_nome, v_ident.situacao, v_ident.candidatos, now(),
      v_sync
    )
    RETURNING id INTO v_conversa_id;
  END IF;

  v_previa := left(coalesce(nullif(btrim(p_texto), ''),
                            '[' || coalesce(p_tipo, 'midia') || ']'), 120);

  INSERT INTO public.whatsapp_mensagens (
    conversa_id, wamid, direcao, tipo, texto, midia_id, midia_mime,
    status, enviado_por_email, origem, timestamp_wa, payload
  ) VALUES (
    v_conversa_id, p_wamid, p_direcao, coalesce(p_tipo, 'text'), p_texto,
    p_midia_id, p_midia_mime, p_status, p_enviado_por,
    coalesce(p_origem, 'TEMPO_REAL'), v_ts, p_payload
  )
  ON CONFLICT (wamid) DO NOTHING;

  -- wamid já existia: é reentrega ou eco. Não mexe em contador nem em prévia.
  IF NOT FOUND THEN
    RETURN v_conversa_id;
  END IF;

  UPDATE public.whatsapp_conversas
  SET ultima_mensagem_em     = greatest(coalesce(ultima_mensagem_em, v_ts), v_ts),
      -- Só reescreve a prévia se esta mensagem é a mais recente da conversa —
      -- na importação do histórico os lotes chegam fora de ordem.
      ultima_mensagem_previa = CASE
                                 WHEN ultima_mensagem_em IS NULL OR v_ts >= ultima_mensagem_em
                                 THEN v_previa ELSE ultima_mensagem_previa
                               END,
      nome_perfil            = coalesce(p_nome_perfil, nome_perfil),
      -- Historico importado NAO conta como "nao lida": ele e passado do
      -- aparelho, nao novidade que chegou agora. Sem isto o primeiro pareamento
      -- marcaria milhares de conversas como nao lidas e o contador da central
      -- nasceria mentindo. Para o historico o sinal certo e `aguardando_resposta`.
      nao_lidas              = CASE
                                 WHEN p_direcao = 'ENTRADA' AND NOT v_sync THEN nao_lidas + 1
                                 WHEN p_direcao = 'SAIDA'                  THEN 0
                                 ELSE nao_lidas
                               END,
      -- Mensagem nova reabre conversa encerrada: quem voltou a escrever voltou
      -- para a fila, senão o retorno do aluno some.
      status                 = CASE
                                 WHEN p_direcao = 'ENTRADA' AND status = 'ENCERRADO' THEN 'NOVO'
                                 WHEN p_direcao = 'SAIDA'   AND status = 'NOVO'      THEN 'RESPONDIDO'
                                 ELSE status
                               END,
      atualizado_em          = now()
  WHERE id = v_conversa_id;

  RETURN v_conversa_id;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_registrar_mensagem(text,text,text,text,text,text,text,text,text,timestamptz,jsonb,text,text,text)
  FROM PUBLIC, anon, authenticated;

------------------------------------------------------------------------------
-- 13) SEM RETORNO — mantido por trigger, nunca por quem atende.
--
--     REGRA: a última mensagem da conversa é de quem escreveu => está
--     esperando. Respondemos => sai da fila.
--
--     POR QUE TRIGGER: existem três caminhos de escrita (entrada em tempo real,
--     resposta do CRM e importação do histórico). No trigger é impossível um
--     deles esquecer de atualizar.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_whatsapp_aguardando()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_ultima timestamptz;
BEGIN
  -- Na importação do histórico os lotes chegam fora de ordem: uma mensagem
  -- ANTIGA não pode redefinir o estado atual da fila. Só a mais recente manda.
  SELECT max(m.timestamp_wa) INTO v_ultima
  FROM public.whatsapp_mensagens m
  WHERE m.conversa_id = new.conversa_id;

  IF v_ultima IS NOT NULL AND new.timestamp_wa < v_ultima THEN
    -- Chegou fora de ordem. Ainda assim pode antecipar o INÍCIO da espera.
    IF new.direcao = 'ENTRADA' THEN
      UPDATE public.whatsapp_conversas
      SET aguardando_desde = least(coalesce(aguardando_desde, new.timestamp_wa), new.timestamp_wa)
      WHERE id = new.conversa_id AND aguardando_resposta;
    END IF;
    RETURN new;
  END IF;

  IF new.direcao = 'ENTRADA' THEN
    -- `aguardando_desde` marca a PRIMEIRA mensagem sem resposta — se a pessoa
    -- mandar 5 seguidas, a espera conta desde a primeira. É o que reflete a
    -- espera real de quem está do outro lado.
    UPDATE public.whatsapp_conversas
    SET aguardando_resposta = true,
        aguardando_desde    = coalesce(aguardando_desde, new.timestamp_wa),
        atualizado_em       = now()
    WHERE id = new.conversa_id;

  ELSIF new.direcao = 'SAIDA' THEN
    -- Só sai da fila se a mensagem REALMENTE saiu. Tentativa falha continua
    -- esperando — senão um erro de envio esconderia a pessoa da fila, que é
    -- exatamente o jeito de perder alguém sem ninguém notar.
    IF coalesce(new.status, '') <> 'FALHOU' THEN
      UPDATE public.whatsapp_conversas
      SET aguardando_resposta = false,
          aguardando_desde    = NULL,
          atualizado_em       = now()
      WHERE id = new.conversa_id;
    END IF;
  END IF;

  RETURN new;
END;
$function$;

DROP TRIGGER IF EXISTS trg_whatsapp_aguardando ON public.whatsapp_mensagens;
CREATE TRIGGER trg_whatsapp_aguardando
  AFTER INSERT ON public.whatsapp_mensagens
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_whatsapp_aguardando();

------------------------------------------------------------------------------
-- 14) Estado da conexão reportado pelo gateway.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_conexao_reportar(
  p_sessao_chave text,
  p_status       text,
  p_detalhe      text DEFAULT NULL,
  p_qr_code      text DEFAULT NULL,
  p_qr_ttl_seg   integer DEFAULT NULL,
  p_jid          text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canal_id uuid;
  v_antes    text;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'whatsapp_conexao_reportar: acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT id, conexao_status INTO v_canal_id, v_antes
  FROM public.whatsapp_canais WHERE sessao_chave = p_sessao_chave;

  IF v_canal_id IS NULL THEN
    RAISE EXCEPTION 'canal desconhecido para sessao %', p_sessao_chave;
  END IF;

  UPDATE public.whatsapp_canais
  SET conexao_status        = p_status,
      conexao_detalhe       = p_detalhe,
      conexao_atualizada_em = now(),
      ultimo_heartbeat_em   = now(),
      conectado_em          = CASE WHEN p_status = 'CONECTADO' AND conexao_status <> 'CONECTADO'
                                   THEN now() ELSE conectado_em END,
      jid_conectado         = coalesce(p_jid, jid_conectado),
      -- QR só vale enquanto o status for de espera de leitura; em qualquer
      -- outro estado ele é apagado na hora. QR é credencial, não histórico.
      qr_code               = CASE WHEN p_status = 'AGUARDANDO_QR' THEN coalesce(p_qr_code, qr_code) ELSE NULL END,
      qr_expira_em          = CASE WHEN p_status = 'AGUARDANDO_QR'
                                   THEN now() + make_interval(secs => coalesce(p_qr_ttl_seg, 60))
                                   ELSE NULL END
  WHERE id = v_canal_id;

  -- Só registra evento quando o estado MUDA. Heartbeat de 30s não pode virar
  -- 2.880 linhas por dia por canal.
  IF v_antes IS DISTINCT FROM p_status THEN
    INSERT INTO public.whatsapp_conexao_eventos (canal_id, sessao_chave, evento, detalhe)
    VALUES (v_canal_id, p_sessao_chave, p_status, p_detalhe);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_conexao_reportar(text,text,text,text,integer,text)
  FROM PUBLIC, anon, authenticated;

------------------------------------------------------------------------------
-- 15) Sincronização inicial: abrir, contar, fechar.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_sync_abrir(p_sessao_chave text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canal_id uuid;
  v_id       uuid;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_canal_id FROM public.whatsapp_canais WHERE sessao_chave = p_sessao_chave;
  IF v_canal_id IS NULL THEN
    RAISE EXCEPTION 'canal desconhecido para sessao %', p_sessao_chave;
  END IF;

  -- Reaproveita a execução em andamento: a sincronização chega em vários lotes
  -- e todos pertencem à mesma importação.
  SELECT id INTO v_id
  FROM public.whatsapp_sync_execucoes
  WHERE canal_id = v_canal_id AND status = 'EM_ANDAMENTO'
  ORDER BY iniciado_em DESC LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO public.whatsapp_sync_execucoes (canal_id) VALUES (v_canal_id) RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_sync_contabilizar(
  p_sync_id     uuid,
  p_conversas   integer DEFAULT 0,
  p_mensagens   integer DEFAULT 0,
  p_contatos    integer DEFAULT 0,
  p_lote_final  boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  UPDATE public.whatsapp_sync_execucoes
  SET lotes_recebidos      = lotes_recebidos + 1,
      conversas_criadas    = conversas_criadas + coalesce(p_conversas, 0),
      mensagens_importadas = mensagens_importadas + coalesce(p_mensagens, 0),
      contatos_recebidos   = contatos_recebidos + coalesce(p_contatos, 0),
      ultimo_lote_final    = ultimo_lote_final OR coalesce(p_lote_final, false)
  WHERE id = p_sync_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_sync_concluir(
  p_sync_id uuid,
  p_erro    text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canal_id uuid;
  v_pend     integer;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT canal_id INTO v_canal_id FROM public.whatsapp_sync_execucoes WHERE id = p_sync_id;
  IF v_canal_id IS NULL THEN RETURN; END IF;

  -- POSSÍVEL PENDÊNCIA: conversa importada cuja última mensagem é do aluno e
  -- não teve resposta depois. O trigger já derivou `aguardando_resposta`; aqui
  -- só contamos, para a operação saber o tamanho do resgate.
  SELECT count(*) INTO v_pend
  FROM public.whatsapp_conversas c
  WHERE c.canal_id = v_canal_id AND c.origem_sync AND c.aguardando_resposta;

  UPDATE public.whatsapp_sync_execucoes
  SET status                = CASE WHEN p_erro IS NULL THEN 'CONCLUIDA' ELSE 'FALHOU' END,
      concluido_em          = now(),
      pendencias_detectadas = v_pend,
      erro                  = p_erro
  WHERE id = p_sync_id;

  IF p_erro IS NULL THEN
    UPDATE public.whatsapp_canais SET sync_inicial_em = now() WHERE id = v_canal_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_sync_abrir(text)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_sync_contabilizar(uuid,integer,integer,integer,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_sync_concluir(uuid,text)                          FROM PUBLIC, anon, authenticated;

------------------------------------------------------------------------------
-- 16) RPCs da tela — todas autorizadas pelo JWT, nunca por dado do frontend.
------------------------------------------------------------------------------

-- 16.1 Lista de conversas. Os DOIS números vêm juntos; `p_canal_id` é filtro de
--      visualização.
--
--      `p_status` aceita, além dos status reais, pseudo-status derivados:
--        SEM_RETORNO    -> só quem espera, do MAIS ANTIGO primeiro
--        NAO_LIDAS      -> com mensagem não vista
--        SEM_RESPONSAVEL-> ninguém assumiu ainda
--        MINHAS         -> as minhas
--
--      A busca cobre nome de perfil, telefone, e — quando a conversa tem aluno
--      identificado — nome do aluno, CPF e matrícula. O join com `alunos` só
--      acontece quando há texto de busca; a listagem normal não toca a base.
CREATE OR REPLACE FUNCTION public.whatsapp_conversas_listar(
  p_status      text    DEFAULT NULL,
  p_canal_id    uuid    DEFAULT NULL,
  p_busca       text    DEFAULT NULL,
  p_limite      integer DEFAULT 100,
  p_responsavel text    DEFAULT NULL
)
RETURNS TABLE (
  id                     uuid,
  canal_id               uuid,
  canal_apelido          text,
  canal_numero           text,
  telefone_e164          text,
  nome_perfil            text,
  status                 text,
  responsavel_email      text,
  responsavel_nome       text,
  nao_lidas              integer,
  aluno_id               uuid,
  aluno_nome             text,
  aluno_status           text,
  ultima_mensagem_em     timestamptz,
  ultima_mensagem_previa text,
  aguardando_resposta    boolean,
  aguardando_desde       timestamptz,
  origem_sync            boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtro AS (
    SELECT nullif(btrim(coalesce(p_busca, '')), '')            AS termo,
           regexp_replace(coalesce(p_busca, ''), '\D', '', 'g') AS digitos
  )
  SELECT
    c.id, c.canal_id, k.apelido, k.display_phone_number,
    c.telefone_e164, c.nome_perfil,
    c.status, c.responsavel_email, c.responsavel_nome, c.nao_lidas,
    c.aluno_id, c.aluno_nome, c.aluno_status,
    c.ultima_mensagem_em, c.ultima_mensagem_previa,
    c.aguardando_resposta, c.aguardando_desde, c.origem_sync
  FROM public.whatsapp_conversas c
  JOIN public.whatsapp_canais k ON k.id = c.canal_id
  CROSS JOIN filtro f
  WHERE public.app_usuario_ativo()
    AND (
      p_status IS NULL
      OR (p_status = 'SEM_RETORNO'     AND c.aguardando_resposta)
      OR (p_status = 'NAO_LIDAS'       AND c.nao_lidas > 0)
      OR (p_status = 'SEM_RESPONSAVEL' AND c.responsavel_email IS NULL AND c.status <> 'ENCERRADO')
      OR (p_status = 'MINHAS'          AND c.responsavel_email = public.app_email())
      OR (p_status NOT IN ('SEM_RETORNO','NAO_LIDAS','SEM_RESPONSAVEL','MINHAS')
          AND c.status = p_status)
    )
    AND (p_canal_id IS NULL OR c.canal_id = p_canal_id)
    AND (p_responsavel IS NULL OR c.responsavel_email = p_responsavel)
    AND (
      f.termo IS NULL
      OR c.nome_perfil ILIKE '%' || f.termo || '%'
      OR c.aluno_nome  ILIKE '%' || f.termo || '%'
      OR (f.digitos <> '' AND c.telefone_e164 ILIKE '%' || f.digitos || '%')
      -- CPF e matrícula só entram quando a conversa tem aluno vinculado.
      OR (c.aluno_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.alunos a
            WHERE a.id = c.aluno_id
              AND (
                (f.digitos <> '' AND regexp_replace(coalesce(a.cpf,''), '\D', '', 'g') = f.digitos)
                OR a.matricula ILIKE f.termo
              )
          ))
    )
  -- Na fila de sem retorno, quem espera há MAIS tempo vem primeiro. Nos outros
  -- modos, a conversa com movimento mais recente no topo.
  ORDER BY
    CASE WHEN p_status = 'SEM_RETORNO' THEN c.aguardando_desde END ASC NULLS LAST,
    c.ultima_mensagem_em DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limite, 100), 300));
$$;

-- 16.2 Thread de uma conversa.
CREATE OR REPLACE FUNCTION public.whatsapp_mensagens_listar(
  p_conversa_id uuid,
  p_limite      integer DEFAULT 200
)
RETURNS TABLE (
  id                uuid,
  direcao           text,
  tipo              text,
  texto             text,
  midia_id          text,
  midia_mime        text,
  status            text,
  erro_detalhe      text,
  enviado_por_email text,
  origem            text,
  timestamp_wa      timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.direcao, m.tipo, m.texto, m.midia_id, m.midia_mime,
         m.status, m.erro_detalhe, m.enviado_por_email, m.origem, m.timestamp_wa
  FROM public.whatsapp_mensagens m
  WHERE public.app_usuario_ativo()
    AND m.conversa_id = p_conversa_id
  ORDER BY m.timestamp_wa DESC
  LIMIT greatest(1, least(coalesce(p_limite, 200), 500));
$$;

-- 16.3 Responsável: assumir, transferir, liberar.
--
--      Assumir é o ato que evita dois operadores no mesmo aluno. Quem já tem
--      dono só é assumido por gestão — senão a "trava" seria decorativa.
CREATE OR REPLACE FUNCTION public.whatsapp_assumir_conversa(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dono  text;
  v_email text := public.app_email();
  v_nome  text;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT responsavel_email INTO v_dono
  FROM public.whatsapp_conversas WHERE id = p_conversa_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversa inexistente'; END IF;

  IF v_dono IS NOT NULL AND v_dono <> v_email AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'conversa ja esta com %', v_dono USING ERRCODE = '42501';
  END IF;

  SELECT u.nome INTO v_nome FROM public.usuarios u WHERE u.email = v_email;

  UPDATE public.whatsapp_conversas
  SET responsavel_email = v_email,
      responsavel_nome  = coalesce(v_nome, v_email),
      responsavel_desde = now(),
      status            = 'EM_ATENDIMENTO',
      nao_lidas         = 0,
      atualizado_em     = now()
  WHERE id = p_conversa_id;

  INSERT INTO public.whatsapp_conexao_eventos (canal_id, evento, detalhe, por_email)
  SELECT c.canal_id, 'COMANDO', 'assumiu conversa ' || p_conversa_id, v_email
  FROM public.whatsapp_conversas c WHERE c.id = p_conversa_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_transferir_conversa(
  p_conversa_id uuid,
  p_para_email  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nome  text;
  v_ativo boolean;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT u.nome, u.ativo INTO v_nome, v_ativo
  FROM public.usuarios u WHERE lower(u.email) = lower(p_para_email);

  IF v_nome IS NULL OR NOT coalesce(v_ativo, false) THEN
    RAISE EXCEPTION 'destinatario inexistente ou inativo: %', p_para_email;
  END IF;

  UPDATE public.whatsapp_conversas
  SET responsavel_email = lower(p_para_email),
      responsavel_nome  = v_nome,
      responsavel_desde = now(),
      status            = CASE WHEN status = 'ENCERRADO' THEN 'EM_ATENDIMENTO' ELSE status END,
      atualizado_em     = now()
  WHERE id = p_conversa_id;

  INSERT INTO public.whatsapp_conexao_eventos (canal_id, evento, detalhe, por_email)
  SELECT c.canal_id, 'COMANDO',
         'transferiu conversa ' || p_conversa_id || ' para ' || lower(p_para_email),
         public.app_email()
  FROM public.whatsapp_conversas c WHERE c.id = p_conversa_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_retirar_responsavel(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dono text;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT responsavel_email INTO v_dono FROM public.whatsapp_conversas WHERE id = p_conversa_id;

  -- Devolver para a fila é ato do dono ou da gestão. Tirar o atendimento da mão
  -- de outra pessoa sem ser gestão seria abrir a porta para conflito.
  IF v_dono IS NOT NULL AND v_dono <> public.app_email() AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'somente o responsavel ou a gestao pode liberar' USING ERRCODE = '42501';
  END IF;

  UPDATE public.whatsapp_conversas
  SET responsavel_email = NULL,
      responsavel_nome  = NULL,
      responsavel_desde = NULL,
      atualizado_em     = now()
  WHERE id = p_conversa_id;
END;
$$;

-- 16.4 Lida / encerrar / reabrir.
CREATE OR REPLACE FUNCTION public.whatsapp_marcar_lida(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;
  -- Zera o "não lida" e NADA MAIS. Ler não responde: `aguardando_resposta`
  -- continua verdadeiro e a conversa continua na fila. Foi pedido explícito —
  -- conversa não pode sumir da fila só porque alguém abriu.
  UPDATE public.whatsapp_conversas
  SET nao_lidas = 0, atualizado_em = now()
  WHERE id = p_conversa_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_encerrar_conversa(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;
  UPDATE public.whatsapp_conversas
  SET status              = 'ENCERRADO',
      nao_lidas           = 0,
      aguardando_resposta = false,
      aguardando_desde    = NULL,
      atualizado_em       = now()
  WHERE id = p_conversa_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_reabrir_conversa(p_conversa_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;
  UPDATE public.whatsapp_conversas
  SET status = 'EM_ATENDIMENTO', atualizado_em = now()
  WHERE id = p_conversa_id AND status = 'ENCERRADO';
END;
$$;

-- 16.5 Preparar envio. A Edge Function chama isto com o JWT do operador ANTES
--      de falar com o gateway.
--
--      DUAS INVARIANTES: o número de saída é DERIVADO da conversa (nunca vem do
--      frontend) e a conversa precisa estar livre ou ser sua. Não há mais regra
--      de janela de 24h — ela era da Cloud API e não existe neste caminho.
CREATE OR REPLACE FUNCTION public.whatsapp_preparar_envio(p_conversa_id uuid)
RETURNS TABLE (
  sessao_chave   text,
  telefone_e164  text,
  operador_email text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv  public.whatsapp_conversas%ROWTYPE;
  v_canal public.whatsapp_canais%ROWTYPE;
  v_email text := public.app_email();
  v_nome  text;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.whatsapp_conversas WHERE id = p_conversa_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversa inexistente'; END IF;

  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = v_conv.canal_id;
  IF NOT FOUND OR NOT v_canal.ativo THEN RAISE EXCEPTION 'canal inativo'; END IF;

  IF v_canal.conexao_status <> 'CONECTADO' THEN
    RAISE EXCEPTION 'numero % esta % - reconecte antes de responder',
      v_canal.apelido, v_canal.conexao_status USING ERRCODE = '42501';
  END IF;

  IF v_conv.responsavel_email IS NOT NULL
     AND v_conv.responsavel_email <> v_email
     AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'conversa em atendimento por %', v_conv.responsavel_email
      USING ERRCODE = '42501';
  END IF;

  -- Responder é assumir: sem isso, dois operadores digitam ao mesmo tempo e o
  -- aluno recebe resposta dobrada.
  IF v_conv.responsavel_email IS NULL THEN
    SELECT u.nome INTO v_nome FROM public.usuarios u WHERE u.email = v_email;
    UPDATE public.whatsapp_conversas
    SET responsavel_email = v_email,
        responsavel_nome  = coalesce(v_nome, v_email),
        responsavel_desde = now(),
        status            = 'EM_ATENDIMENTO',
        atualizado_em     = now()
    WHERE id = p_conversa_id;
  END IF;

  RETURN QUERY SELECT v_canal.sessao_chave, v_conv.telefone_e164, v_email;
END;
$$;

-- 16.6 Canais para a tela: estado da conexão SEM o QR.
--
--      `online` não acredita no status sozinho: um processo morto nunca reporta
--      "caiu". Se o heartbeat parou, o canal está fora, diga o que disser a
--      última linha gravada.
CREATE OR REPLACE FUNCTION public.whatsapp_canais_listar()
RETURNS TABLE (
  id                    uuid,
  apelido               text,
  display_phone_number  text,
  ativo                 boolean,
  conexao_status        text,
  conexao_detalhe       text,
  conexao_atualizada_em timestamptz,
  ultimo_heartbeat_em   timestamptz,
  online                boolean,
  sync_inicial_em       timestamptz,
  aguardando_qr         boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT k.id, k.apelido, k.display_phone_number, k.ativo,
         k.conexao_status, k.conexao_detalhe, k.conexao_atualizada_em,
         k.ultimo_heartbeat_em,
         (k.conexao_status = 'CONECTADO'
          AND k.ultimo_heartbeat_em IS NOT NULL
          AND k.ultimo_heartbeat_em > now() - make_interval(
                mins => (SELECT minutos_sem_heartbeat_alerta FROM public.whatsapp_config WHERE id))
         ) AS online,
         k.sync_inicial_em,
         (k.conexao_status = 'AGUARDANDO_QR' AND k.qr_expira_em > now()) AS aguardando_qr
  FROM public.whatsapp_canais k
  WHERE public.app_usuario_ativo()
  ORDER BY k.apelido;
$$;

-- 16.7 QR Code: SOMENTE gestão, e a leitura fica registrada.
--      Quem lê este QR ganha acesso ao WhatsApp da empresa. Trata-se como
--      credencial, não como imagem de tela.
CREATE OR REPLACE FUNCTION public.whatsapp_canal_qr(p_canal_id uuid)
RETURNS TABLE (qr_code text, qr_expira_em timestamptz, conexao_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'somente gestao' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.whatsapp_conexao_eventos (canal_id, evento, detalhe, por_email)
  VALUES (p_canal_id, 'QR_EXIBIDO', 'QR consultado na Central', public.app_email());

  RETURN QUERY
    SELECT k.qr_code, k.qr_expira_em, k.conexao_status
    FROM public.whatsapp_canais k
    WHERE k.id = p_canal_id AND k.qr_expira_em > now();
END;
$$;

-- 16.8 Cadastro dos canais (gestão).
CREATE OR REPLACE FUNCTION public.whatsapp_canal_salvar(
  p_apelido        text,
  p_display_numero text,
  p_sessao_chave   text,
  p_id             uuid    DEFAULT NULL,
  p_ativo          boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'somente gestao' USING ERRCODE = '42501';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.whatsapp_canais (apelido, display_phone_number, sessao_chave, ativo)
    VALUES (btrim(p_apelido), btrim(p_display_numero), btrim(lower(p_sessao_chave)), coalesce(p_ativo, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.whatsapp_canais
    SET apelido              = btrim(p_apelido),
        display_phone_number = btrim(p_display_numero),
        sessao_chave         = btrim(lower(p_sessao_chave)),
        ativo                = coalesce(p_ativo, true)
    WHERE id = p_id
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$;

-- 16.9 Vínculo manual com o aluno — é como a ambiguidade se resolve.
CREATE OR REPLACE FUNCTION public.whatsapp_vincular_aluno(
  p_conversa_id uuid,
  p_aluno_id    uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_nome text;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  IF p_aluno_id IS NULL THEN
    UPDATE public.whatsapp_conversas
    SET aluno_id = NULL, aluno_nome = NULL, aluno_status = 'NAO_ENCONTRADO',
        aluno_candidatos = NULL, atualizado_em = now()
    WHERE id = p_conversa_id;
    RETURN;
  END IF;

  SELECT coalesce(a.nome, a.nome_aluno) INTO v_nome FROM public.alunos a WHERE a.id = p_aluno_id;
  IF v_nome IS NULL THEN RAISE EXCEPTION 'aluno inexistente'; END IF;

  UPDATE public.whatsapp_conversas
  SET aluno_id              = p_aluno_id,
      aluno_nome            = v_nome,
      aluno_status          = 'MANUAL',
      aluno_candidatos      = NULL,
      aluno_identificado_em = now(),
      atualizado_em         = now()
  WHERE id = p_conversa_id;
END;
$$;

-- 16.10 Candidatos guardados na conversa ambígua (para a tela oferecer escolha).
CREATE OR REPLACE FUNCTION public.whatsapp_conversa_candidatos(p_conversa_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.aluno_candidatos
  FROM public.whatsapp_conversas c
  WHERE public.app_usuario_ativo() AND c.id = p_conversa_id;
$$;

-- 16.11 FICHA LEVE, sob demanda. Só é chamada quando o operador ABRE a conversa
--       — nunca na listagem. Uma linha de `alunos` + contagem de acordos; o
--       resto continua na ficha completa, a um clique.
CREATE OR REPLACE FUNCTION public.whatsapp_aluno_resumo(p_conversa_id uuid)
RETURNS TABLE (
  aluno_id             uuid,
  nome                 text,
  matricula            text,
  cpf_mascarado        text,
  telefone             text,
  curso                text,
  unidade              text,
  situacao_academica   text,
  situacao_operacional text,
  nivel_criticidade    text,
  status_atual         text,
  saldo_vencido        numeric,
  saldo_total          numeric,
  responsavel_carteira text,
  acordos_ativos       integer,
  data_retorno         date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id, coalesce(a.nome, a.nome_aluno), a.matricula, a.cpf_mascarado, a.telefone,
    coalesce(a.curso_real, a.curso), a.unidade,
    a.situacao_academica, a.situacao_operacional, a.nivel_criticidade, a.status_atual,
    a.saldo_vencido, a.saldo_total, a.responsavel_atual_nome,
    (SELECT count(*)::integer FROM public.acordos ac
      WHERE ac.aluno_id = a.id AND coalesce(ac.status,'') NOT IN ('CANCELADO','QUITADO')),
    a.data_retorno
  FROM public.whatsapp_conversas c
  JOIN public.alunos a ON a.id = c.aluno_id
  WHERE public.app_usuario_ativo() AND c.id = p_conversa_id;
$$;

-- 16.12 Busca de aluno para vincular à mão (nome, CPF ou matrícula).
CREATE OR REPLACE FUNCTION public.whatsapp_buscar_aluno(p_termo text, p_limite integer DEFAULT 20)
RETURNS TABLE (id uuid, nome text, matricula text, curso text, telefone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH t AS (
    SELECT nullif(btrim(coalesce(p_termo,'')), '')             AS termo,
           regexp_replace(coalesce(p_termo,''), '\D', '', 'g')  AS digitos
  )
  SELECT a.id, coalesce(a.nome, a.nome_aluno), a.matricula,
         coalesce(a.curso_real, a.curso), a.telefone
  FROM public.alunos a CROSS JOIN t
  WHERE public.app_usuario_ativo()
    AND t.termo IS NOT NULL
    AND (
      coalesce(a.nome, a.nome_aluno) ILIKE '%' || t.termo || '%'
      OR a.matricula ILIKE t.termo
      OR (t.digitos <> '' AND regexp_replace(coalesce(a.cpf,''), '\D', '', 'g') = t.digitos)
      OR (t.digitos <> '' AND public.whatsapp_chave_telefone(a.telefone) = public.whatsapp_chave_telefone(t.digitos))
    )
  ORDER BY coalesce(a.nome, a.nome_aluno)
  LIMIT greatest(1, least(coalesce(p_limite, 20), 50));
$$;

-- 16.13 Operadores para o seletor de transferência.
CREATE OR REPLACE FUNCTION public.whatsapp_operadores_listar()
RETURNS TABLE (email text, nome text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.email, u.nome
  FROM public.usuarios u
  WHERE public.app_usuario_ativo() AND u.ativo
  ORDER BY u.nome;
$$;

------------------------------------------------------------------------------
-- 17) Painéis: resumo da central e supervisão.
------------------------------------------------------------------------------

-- 17.1 Resumo — os números que faltam na cabeça da operação. Uma chamada
--      devolve o painel inteiro, sem varrer a tabela por tela.
CREATE OR REPLACE FUNCTION public.whatsapp_resumo()
RETURNS TABLE (
  sem_retorno        integer,
  esperando_mais_1h  integer,
  esperando_mais_24h integer,
  espera_mais_antiga timestamptz,
  nao_lidas          integer,
  sem_responsavel    integer,
  em_atendimento     integer,
  minhas             integer,
  pendencias_resgate integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*) FILTER (WHERE c.aguardando_resposta)::integer,
    count(*) FILTER (WHERE c.aguardando_resposta
                       AND c.aguardando_desde < now() - interval '1 hour')::integer,
    count(*) FILTER (WHERE c.aguardando_resposta
                       AND c.aguardando_desde < now() - interval '24 hours')::integer,
    min(c.aguardando_desde) FILTER (WHERE c.aguardando_resposta),
    coalesce(sum(c.nao_lidas), 0)::integer,
    count(*) FILTER (WHERE c.responsavel_email IS NULL)::integer,
    count(*) FILTER (WHERE c.status = 'EM_ATENDIMENTO')::integer,
    count(*) FILTER (WHERE c.responsavel_email = public.app_email())::integer,
    -- Resgate: pendência que veio do histórico do aparelho e ainda não foi
    -- respondida. É o placar do "não perder quem já tinha chamado".
    count(*) FILTER (WHERE c.origem_sync AND c.aguardando_resposta)::integer
  FROM public.whatsapp_conversas c
  WHERE public.app_usuario_ativo()
    AND c.status <> 'ENCERRADO';
$$;

-- 17.2 Supervisão. Fase 1: o essencial para saber onde está a fila e quem está
--      com o quê. Indicador fino fica para depois, de propósito.
CREATE OR REPLACE FUNCTION public.whatsapp_supervisao()
RETURNS TABLE (
  responsavel_email  text,
  responsavel_nome   text,
  em_atendimento     integer,
  aguardando_resposta integer,
  nao_lidas          integer,
  encerradas_hoje    integer,
  espera_mais_antiga timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    coalesce(c.responsavel_email, '(sem responsavel)'),
    coalesce(c.responsavel_nome,  '(sem responsavel)'),
    count(*) FILTER (WHERE c.status = 'EM_ATENDIMENTO')::integer,
    count(*) FILTER (WHERE c.aguardando_resposta)::integer,
    coalesce(sum(c.nao_lidas), 0)::integer,
    count(*) FILTER (WHERE c.status = 'ENCERRADO'
                       AND c.atualizado_em >= date_trunc('day', now()))::integer,
    min(c.aguardando_desde) FILTER (WHERE c.aguardando_resposta)
  FROM public.whatsapp_conversas c
  WHERE public.usuario_e_gestao()
  GROUP BY 1, 2
  ORDER BY 4 DESC, 3 DESC;
$$;

-- 17.3 Última sincronização por canal — para a tela mostrar o que foi resgatado.
CREATE OR REPLACE FUNCTION public.whatsapp_sync_status()
RETURNS TABLE (
  canal_id              uuid,
  canal_apelido         text,
  status                text,
  iniciado_em           timestamptz,
  concluido_em          timestamptz,
  conversas_criadas     integer,
  mensagens_importadas  integer,
  contatos_recebidos    integer,
  pendencias_detectadas integer,
  erro                  text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (s.canal_id)
    s.canal_id, k.apelido, s.status, s.iniciado_em, s.concluido_em,
    s.conversas_criadas, s.mensagens_importadas, s.contatos_recebidos,
    s.pendencias_detectadas, s.erro
  FROM public.whatsapp_sync_execucoes s
  JOIN public.whatsapp_canais k ON k.id = s.canal_id
  WHERE public.app_usuario_ativo()
  ORDER BY s.canal_id, s.iniciado_em DESC;
$$;

------------------------------------------------------------------------------
-- 18) Grants: nada para anon; execução só para usuário autenticado.
------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.whatsapp_conversas_listar(text,uuid,text,integer,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_mensagens_listar(uuid,integer)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_assumir_conversa(uuid)                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_transferir_conversa(uuid,text)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_retirar_responsavel(uuid)                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_marcar_lida(uuid)                             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_encerrar_conversa(uuid)                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_reabrir_conversa(uuid)                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_preparar_envio(uuid)                          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_canais_listar()                               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_canal_qr(uuid)                                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_canal_salvar(text,text,text,uuid,boolean)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_vincular_aluno(uuid,uuid)                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_conversa_candidatos(uuid)                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_aluno_resumo(uuid)                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_buscar_aluno(text,integer)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_operadores_listar()                           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_resumo()                                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_supervisao()                                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_sync_status()                                 FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.whatsapp_conversas_listar(text,uuid,text,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_mensagens_listar(uuid,integer)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_assumir_conversa(uuid)                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_transferir_conversa(uuid,text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_retirar_responsavel(uuid)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_marcar_lida(uuid)                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_encerrar_conversa(uuid)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_reabrir_conversa(uuid)                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_preparar_envio(uuid)                          TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_canais_listar()                               TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_canal_qr(uuid)                                TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_canal_salvar(text,text,text,uuid,boolean)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_vincular_aluno(uuid,uuid)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_conversa_candidatos(uuid)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_aluno_resumo(uuid)                            TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_buscar_aluno(text,integer)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_operadores_listar()                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_resumo()                                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_supervisao()                                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_sync_status()                                 TO authenticated;

------------------------------------------------------------------------------
-- 19) Realtime: a tela escuta APENAS as mensagens (1 canal, sem polling), no
--     mesmo padrão de `notificacoes`. Conversas são recarregadas por evento,
--     não assinadas — menos tráfego no mesmo resultado. O projeto já teve
--     incidente de CPU por excesso de assinatura; aqui se usa o mínimo.
------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'whatsapp_mensagens'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_mensagens;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 20) LEADS RECEBIDOS — registro manual, funciona sem nenhuma integração.
--
--     POR QUE CONTINUA EXISTINDO: é o caderno de quem procurou antes de a
--     Central entrar no ar, e a rede de segurança para quando um número estiver
--     fora. Aqui não se envia nem se recebe: guarda o contato e abre o WhatsApp
--     no número certo.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_leads (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  telefone_e164   text        NOT NULL,
  nome            text,
  canal_id        uuid        REFERENCES public.whatsapp_canais(id),
  assunto         text,
  status          text        NOT NULL DEFAULT 'NOVO',
  operador_email  text,
  observacao      text,
  registrado_por  text,
  registrado_em   timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_whatsapp_lead_status
    CHECK (status IN ('NOVO','EM_ATENDIMENTO','RESPONDIDO','ENCERRADO'))
);

-- Um lead ABERTO por telefone: registrar de novo devolve o que já existe em vez
-- de duplicar a mesma pessoa na lista.
CREATE UNIQUE INDEX IF NOT EXISTS ux_whatsapp_leads_aberto
  ON public.whatsapp_leads (telefone_e164)
  WHERE status <> 'ENCERRADO';

CREATE INDEX IF NOT EXISTS ix_whatsapp_leads_registro
  ON public.whatsapp_leads (registrado_em DESC);

ALTER TABLE public.whatsapp_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_leads_leitura ON public.whatsapp_leads;
CREATE POLICY whatsapp_leads_leitura ON public.whatsapp_leads
  FOR SELECT TO authenticated
  USING (public.app_usuario_ativo());

CREATE OR REPLACE FUNCTION public.whatsapp_lead_registrar(
  p_telefone text,
  p_nome     text DEFAULT NULL,
  p_canal_id uuid DEFAULT NULL,
  p_assunto  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_e164 text := public.whatsapp_normalizar_telefone(p_telefone);
  v_id   uuid;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;
  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'telefone invalido';
  END IF;

  SELECT id INTO v_id FROM public.whatsapp_leads
  WHERE telefone_e164 = v_e164 AND status <> 'ENCERRADO';

  IF v_id IS NOT NULL THEN
    UPDATE public.whatsapp_leads
    SET nome          = coalesce(nullif(btrim(p_nome), ''), nome),
        assunto       = coalesce(nullif(btrim(p_assunto), ''), assunto),
        canal_id      = coalesce(p_canal_id, canal_id),
        atualizado_em = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.whatsapp_leads (telefone_e164, nome, canal_id, assunto, registrado_por)
  VALUES (v_e164, nullif(btrim(p_nome), ''), p_canal_id, nullif(btrim(p_assunto), ''), public.app_email())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_leads_listar(
  p_status text    DEFAULT NULL,
  p_busca  text    DEFAULT NULL,
  p_limite integer DEFAULT 200
)
RETURNS TABLE (
  id             uuid,
  telefone_e164  text,
  nome           text,
  canal_id       uuid,
  canal_apelido  text,
  assunto        text,
  status         text,
  operador_email text,
  observacao     text,
  registrado_por text,
  registrado_em  timestamptz,
  atualizado_em  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id, l.telefone_e164, l.nome, l.canal_id, k.apelido, l.assunto,
         l.status, l.operador_email, l.observacao, l.registrado_por,
         l.registrado_em, l.atualizado_em
  FROM public.whatsapp_leads l
  LEFT JOIN public.whatsapp_canais k ON k.id = l.canal_id
  WHERE public.app_usuario_ativo()
    AND (p_status IS NULL OR l.status = p_status)
    AND (
      p_busca IS NULL OR btrim(p_busca) = ''
      OR l.nome ILIKE '%' || p_busca || '%'
      OR l.telefone_e164 ILIKE '%' || regexp_replace(p_busca, '\D', '', 'g') || '%'
    )
  ORDER BY l.registrado_em DESC
  LIMIT greatest(1, least(coalesce(p_limite, 200), 500));
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_lead_atualizar(
  p_id         uuid,
  p_status     text    DEFAULT NULL,
  p_observacao text    DEFAULT NULL,
  p_assumir    boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  UPDATE public.whatsapp_leads
  SET status         = coalesce(nullif(btrim(p_status), ''), status),
      observacao     = coalesce(nullif(btrim(p_observacao), ''), observacao),
      operador_email = CASE WHEN coalesce(p_assumir, false) THEN public.app_email() ELSE operador_email END,
      atualizado_em  = now()
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_lead_registrar(text,text,uuid,text)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_leads_listar(text,text,integer)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_lead_atualizar(uuid,text,text,boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.whatsapp_lead_registrar(text,text,uuid,text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_leads_listar(text,text,integer)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_lead_atualizar(uuid,text,text,boolean) TO authenticated;

------------------------------------------------------------------------------
-- 21) Expurgo do log bruto e do diário de conexão: 90 dias. Mantém a
--     caixa-preta útil sem deixar a tabela crescer para sempre (o projeto já
--     teve incidente de I/O).
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_expurgar_eventos()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_qtd integer;
BEGIN
  DELETE FROM public.whatsapp_webhook_eventos WHERE recebido_em < now() - interval '90 days';
  GET DIAGNOSTICS v_qtd = ROW_COUNT;
  DELETE FROM public.whatsapp_conexao_eventos WHERE criado_em < now() - interval '90 days';
  RETURN v_qtd;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_expurgar_eventos() FROM PUBLIC, anon, authenticated;

------------------------------------------------------------------------------
-- 22) RETENÇÃO — 12 MESES (decisão Amanda 2026-08-17, LGPD).
--
--     Conversa de aluno é dado pessoal. A premissa do projeto exige política de
--     retenção explícita, não "guardar para sempre por descuido". Doze meses
--     cobrem o ciclo de cobrança e a necessidade de prova de negociação.
--
--     Roda uma vez por mês, de madrugada — o projeto já teve incidente de
--     carga, então nada de expurgo em horário útil.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_expurgar_retencao()
RETURNS TABLE (
  mensagens_apagadas integer,
  conversas_apagadas integer,
  leads_apagados     integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msg   integer := 0;
  v_conv  integer := 0;
  v_leads integer := 0;
  v_corte timestamptz := now() - interval '12 months';
BEGIN
  DELETE FROM public.whatsapp_mensagens WHERE timestamp_wa < v_corte;
  GET DIAGNOSTICS v_msg = ROW_COUNT;

  DELETE FROM public.whatsapp_conversas
  WHERE coalesce(ultima_mensagem_em, criado_em) < v_corte;
  GET DIAGNOSTICS v_conv = ROW_COUNT;

  DELETE FROM public.whatsapp_leads WHERE registrado_em < v_corte;
  GET DIAGNOSTICS v_leads = ROW_COUNT;

  RETURN QUERY SELECT v_msg, v_conv, v_leads;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_expurgar_retencao() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.whatsapp_expurgar_retencao() IS
  'Retencao LGPD de 12 meses da Central WhatsApp (decisao Amanda 2026-08-17). Roda mensal via cron.';

-- Agendamento mensal: dia 1, 04:10 UTC (01:10 em Brasilia). Só agenda se a
-- extensão existir, para a migration não quebrar em ambiente sem pg_cron.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('whatsapp_retencao_mensal')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp_retencao_mensal');

    PERFORM cron.schedule(
      'whatsapp_retencao_mensal',
      '10 4 1 * *',
      $cron$
        SELECT public.whatsapp_expurgar_retencao();
        SELECT public.whatsapp_expurgar_eventos();
      $cron$
    );
  END IF;
END $$;
