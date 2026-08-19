// Dados de exemplo do preview. Nada aqui vem de produção.
const agora = Date.now();
const atras = (min) => new Date(agora - min * 60000).toISOString();

export const CANAIS = [
  { id: "c1", apelido: "Cobrança", display_phone_number: "+55 51 99631-6324",
    sessao_chave: "cobranca", ativo: true, conexao_status: "CONECTADO", online: true,
    aguardando_qr: false, sync_inicial_em: atras(600) },
  { id: "c2", apelido: "Comercial", display_phone_number: "+55 51 99512-7788",
    sessao_chave: "comercial", ativo: true, conexao_status: "CONECTADO", online: true,
    aguardando_qr: false, sync_inicial_em: atras(600) },
  { id: "c3", apelido: "Secretaria", display_phone_number: "+55 51 3477-9000",
    sessao_chave: "secretaria", ativo: true, conexao_status: "PAREAMENTO_NECESSARIO",
    online: false, aguardando_qr: true, sync_inicial_em: null },
];

export const OPERADORES = [
  { email: "maria@aelbra.com.br", nome: "Maria Souza" },
  { email: "joao@aelbra.com.br", nome: "João Pereira" },
  { email: "rafaella@aelbra.com.br", nome: "Rafaella Lima" },
  { email: "amanda.seibel@aelbra.com.br", nome: "Amanda Seibel" },
];

export const CONVERSAS = [
  { id: "k1", canal_id: "c1", canal_apelido: "Cobrança", canal_numero: "+55 51 99631-6324",
    telefone_e164: "5551988776655", nome_perfil: "Carlos", status: "NOVO",
    responsavel_email: null, responsavel_nome: null, nao_lidas: 3,
    aluno_id: "a1", aluno_nome: "Carlos Eduardo Ramos", aluno_status: "ENCONTRADO",
    ultima_mensagem_em: atras(95), ultima_mensagem_previa: "Consegui pagar hoje, mandei o comprovante",
    aguardando_resposta: true, aguardando_desde: atras(95), origem_sync: false },
  { id: "k2", canal_id: "c2", canal_apelido: "Comercial", canal_numero: "+55 51 99512-7788",
    telefone_e164: "5551997775544", nome_perfil: "Juliana", status: "EM_ATENDIMENTO",
    responsavel_email: "maria@aelbra.com.br", responsavel_nome: "Maria Souza", nao_lidas: 0,
    aluno_id: null, aluno_nome: null, aluno_status: "AMBIGUO",
    ultima_mensagem_em: atras(1900), ultima_mensagem_previa: "Ainda dá pra parcelar em 6x?",
    aguardando_resposta: true, aguardando_desde: atras(1900), origem_sync: false },
  { id: "k3", canal_id: "c1", canal_apelido: "Cobrança", canal_numero: "+55 51 99631-6324",
    telefone_e164: "5551966554433", nome_perfil: null, status: "NOVO",
    responsavel_email: null, responsavel_nome: null, nao_lidas: 1,
    aluno_id: null, aluno_nome: null, aluno_status: "NAO_ENCONTRADO",
    ultima_mensagem_em: atras(28), ultima_mensagem_previa: "Boa tarde, é da ULBRA?",
    aguardando_resposta: true, aguardando_desde: atras(28), origem_sync: false },
  { id: "k4", canal_id: "c1", canal_apelido: "Cobrança", canal_numero: "+55 51 99631-6324",
    telefone_e164: "5551955443322", nome_perfil: "Beatriz", status: "RESPONDIDO",
    responsavel_email: "joao@aelbra.com.br", responsavel_nome: "João Pereira", nao_lidas: 0,
    aluno_id: "a3", aluno_nome: "Beatriz Almeida Nunes", aluno_status: "ENCONTRADO",
    ultima_mensagem_em: atras(200), ultima_mensagem_previa: "Perfeito, obrigada!",
    aguardando_resposta: false, aguardando_desde: null, origem_sync: true },
];

export const MENSAGENS = {
  k1: [
    { id: "m1", direcao: "ENTRADA", texto: "Oi, boa tarde", timestamp_wa: atras(140), status: null, origem: "TEMPO_REAL" },
    { id: "m2", direcao: "SAIDA", texto: "Boa tarde, Carlos! Em que posso ajudar?", timestamp_wa: atras(130), status: "ENVIADO", enviado_por_email: "op@aelbra.com.br", origem: "TEMPO_REAL" },
    { id: "m3", direcao: "ENTRADA", texto: "Consegui pagar hoje, mandei o comprovante", timestamp_wa: atras(95), status: null, origem: "TEMPO_REAL" },
  ],
  k2: [
    { id: "m4", direcao: "ENTRADA", texto: "Ainda dá pra parcelar em 6x?", timestamp_wa: atras(1900), status: null, origem: "TEMPO_REAL" },
  ],
  k3: [
    { id: "m5", direcao: "ENTRADA", texto: "Boa tarde, é da ULBRA?", timestamp_wa: atras(28), status: null, origem: "TEMPO_REAL" },
  ],
  k4: [
    { id: "m6", direcao: "ENTRADA", texto: "Recebi o boleto, valeu", timestamp_wa: atras(240), status: null, origem: "SYNC_INICIAL" },
    { id: "m7", direcao: "SAIDA", texto: "Qualquer coisa é só chamar!", timestamp_wa: atras(200), status: "ENVIADO", origem: "SYNC_INICIAL" },
  ],
  "k-nova": [
    { id: "m9", direcao: "SAIDA", texto: "Bom dia, Ana! Aqui é a ULBRA. Vi que sua rematrícula está pendente — posso te ajudar?",
      timestamp_wa: new Date().toISOString(), status: "ENVIADO", enviado_por_email: "op@aelbra.com.br", origem: "TEMPO_REAL" },
  ],
};

export const RESUMO = {
  sem_retorno: 3, esperando_mais_1h: 2, esperando_mais_24h: 1,
  sem_responsavel: 2, minhas: 1, pendencias_resgate: 4,
  espera_mais_antiga: atras(1900),
};

export const SUPERVISAO = [
  { responsavel_email: "maria@aelbra.com.br", responsavel_nome: "Maria Souza",
    em_atendimento: 6, aguardando_resposta: 2, nao_lidas: 0, encerradas_hoje: 11, espera_mais_antiga: atras(1900) },
  { responsavel_email: "joao@aelbra.com.br", responsavel_nome: "João Pereira",
    em_atendimento: 4, aguardando_resposta: 0, nao_lidas: 1, encerradas_hoje: 7, espera_mais_antiga: null },
  { responsavel_email: "rafaella@aelbra.com.br", responsavel_nome: "Rafaella Lima",
    em_atendimento: 9, aguardando_resposta: 5, nao_lidas: 3, encerradas_hoje: 3, espera_mais_antiga: atras(320) },
];

export const SYNC = [
  { canal_id: "c1", canal_apelido: "Cobrança", status: "CONCLUIDA", conversas_criadas: 812,
    mensagens_importadas: 9471, pendencias_detectadas: 37, erro: null },
];

export const ALUNOS = [
  { id: "a5", nome: "Ana Paula Ferreira", matricula: "20231045", curso: "Direito", telefone: "51988112233" },
  { id: "a6", nome: "Ana Carolina Souza", matricula: "20219877", curso: "Enfermagem", telefone: "51997654321" },
  { id: "a7", nome: "Ana Beatriz Lopes", matricula: "20224411", curso: "Psicologia", telefone: null },
];

export const FICHA = {
  aluno_id: "a1", nome: "Carlos Eduardo Ramos", matricula: "20218844",
  cpf_mascarado: "***.456.789-**", curso: "Administração", unidade: "Canoas",
  situacao_academica: "Matriculado", situacao_operacional: "ACORDO_EM_DIA",
  saldo_total: 4382.19, saldo_vencido: 1461.4, acordos_ativos: 1,
  responsavel_carteira: "Rafaella Lima",
};
