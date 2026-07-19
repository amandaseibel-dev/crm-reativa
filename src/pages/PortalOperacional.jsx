import { useState } from "react";

const SECOES = [
  { grupo: "Início", itens: [{ id: "inicio", label: "🏠 Início" }] },
  {
    grupo: "Negociação",
    itens: [
      { id: "politica", label: "📄 Política" },
      { id: "excecao", label: "📝 Proposta de Exceção" },
      { id: "mensagens", label: "💬 Mensagens Prontas" },
      { id: "objecoes", label: "🔥 Objeções" },
      { id: "duvidas", label: "❓ Dúvidas Frequentes" },
    ],
  },
  {
    grupo: "Regras",
    itens: [
      { id: "honorarios", label: "💰 Honorários e Taxas" },
      { id: "meta", label: "🎯 Meta de Honorários" },
      { id: "lgpd", label: "🔐 LGPD e Conduta" },
      { id: "indicadores", label: "📊 Indicadores" },
    ],
  },
  {
    grupo: "Operação",
    itens: [
      { id: "sistemas", label: "🚀 Sistemas Utilizados" },
      { id: "biblioteca", label: "📚 Biblioteca" },
      { id: "contatos", label: "☎️ Contatos Úteis" },
      { id: "sugestoes", label: "💡 Painel de Sugestões" },
    ],
  },
  {
    grupo: "Equipe",
    itens: [
      { id: "cultura", label: "💚 Cultura Reativa" },
      { id: "historia", label: "📸 Nossa História" },
    ],
  },
];

export default function PortalOperacional() {
  const [secao, setSecao] = useState("inicio");

  return (
    <div style={S.pagina}>
      <div style={S.shell}>
        <aside style={S.sidebar}>
          <div style={S.logoBox}>
            <span style={S.logoRe}>Re</span>
            <span style={S.logoAtiva}>ATIVA</span>
          </div>
          <div style={S.logoSub}>Portal Operacional</div>

          <nav style={S.nav}>
            {SECOES.map((g) => (
              <div key={g.grupo} style={S.navGrupo}>
                <div style={S.navGrupoLabel}>{g.grupo}</div>
                {g.itens.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => setSecao(it.id)}
                    style={{
                      ...S.navItem,
                      ...(secao === it.id ? S.navItemAtivo : {}),
                    }}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div style={S.sidebarRodape}>💚 Central oficial da operação</div>
        </aside>

        <main style={S.conteudo}>
          {secao === "inicio" && <SecaoInicio ir={setSecao} />}
          {secao === "politica" && <SecaoPolitica />}
          {secao === "excecao" && <SecaoExcecao />}
          {secao === "mensagens" && <SecaoMensagens />}
          {secao === "objecoes" && <SecaoObjecoes />}
          {secao === "duvidas" && <SecaoDuvidas />}
          {secao === "honorarios" && <SecaoHonorarios />}
          {secao === "meta" && <SecaoMeta />}
          {secao === "lgpd" && <SecaoLgpd />}
          {secao === "indicadores" && <SecaoIndicadores />}
          {secao === "sistemas" && <SecaoSistemas />}
          {secao === "biblioteca" && <SecaoBiblioteca ir={setSecao} />}
          {secao === "contatos" && <SecaoContatos />}
          {secao === "sugestoes" && <SecaoSugestoes />}
          {secao === "cultura" && <SecaoCultura />}
          {secao === "historia" && <SecaoHistoria />}
        </main>
      </div>
    </div>
  );
}

/* ===================== Componentes visuais reutilizáveis ===================== */

function TituloSecao({ emoji, titulo, sub }) {
  return (
    <div style={S.tituloSecaoBox}>
      <h1 style={S.tituloSecaoH1}>
        {emoji} {titulo}
      </h1>
      {sub && <p style={S.tituloSecaoSub}>{sub}</p>}
    </div>
  );
}

function Card({ children, style }) {
  return <div style={{ ...S.card, ...style }}>{children}</div>;
}

function Aviso({ children, tom = "atencao" }) {
  return (
    <div style={{ ...S.aviso, ...(tom === "atencao" ? S.avisoAtencao : S.avisoInfo) }}>
      {children}
    </div>
  );
}

function BotaoPrimario({ children, href, onClick }) {
  const Comp = href ? "a" : "button";
  return (
    <Comp href={href} target={href ? "_blank" : undefined} rel="noreferrer" onClick={onClick} style={S.botaoPrimario}>
      {children}
    </Comp>
  );
}

function BotaoSecundario({ children, onClick, href }) {
  const Comp = href ? "a" : "button";
  return (
    <Comp href={href} onClick={onClick} style={S.botaoSecundario}>
      {children}
    </Comp>
  );
}

/* ===================== Início ===================== */

function SecaoInicio({ ir }) {
  return (
    <>
      <div style={S.hero}>
        <span style={S.heroEyebrow}>PORTAL OPERACIONAL REATIVA</span>
        <h1 style={S.heroTitulo}>Regras, sistemas, metas e orientações em um só lugar.</h1>
        <p style={S.heroTexto}>
          Tudo o que a equipe precisa pra tocar a rotina de negociação e cobrança com consistência —
          política, mensagens prontas, metas do mês e os sistemas usados no dia a dia.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
          <BotaoPrimario href="https://crm-reativa.vercel.app/">🚀 Acessar Novo Sistema ReATIVA</BotaoPrimario>
          <BotaoSecundario onClick={() => ir("politica")}>📄 Ver Política</BotaoSecundario>
          <BotaoSecundario onClick={() => ir("sugestoes")}>💡 Enviar sugestão</BotaoSecundario>
        </div>
      </div>

      <Aviso>
        <strong>⚠️ Antes de acionar, consulte o CRM.</strong> Verifique se há tabulação anterior,
        observações importantes, jurídico, cancelamento, restrição de contato ou qualquer informação que
        impeça o acionamento. <strong>Não envie várias mensagens para somente depois tabular</strong> —
        primeiro confira se o caso pode ser acionado, depois realize o contato e registre corretamente a
        tratativa.
      </Aviso>

      <div style={S.grade4}>
        <CardAtalho emoji="🚀" titulo="Novo Sistema ReATIVA" desc="Acesso rápido ao CRM operacional." onClick={() => window.open("https://crm-reativa.vercel.app/", "_blank")} />
        <CardAtalho emoji="🎯" titulo="Metas do mês" desc="Faixas de honorários e foco do mês." onClick={() => ir("meta")} />
        <CardAtalho emoji="💬" titulo="Mensagens Prontas" desc="Modelos de atendimento e orientações." onClick={() => ir("mensagens")} />
        <CardAtalho emoji="💡" titulo="Painel de Sugestões" desc="Melhorias para Sistema e Portal Reativa." onClick={() => ir("sugestoes")} />
      </div>

      <Card>
        <h3 style={S.h3}>🎯 Meta do mês</h3>
        <p style={S.paragrafo}>
          <strong>Foco em acordos confirmados, termos corretos e baixas ágeis.</strong> Acompanhar
          diariamente os resultados, priorizando procedimentos completos e registros corretos no CRM.
        </p>
        <BotaoSecundario onClick={() => ir("meta")}>Ver faixas</BotaoSecundario>
      </Card>

      <Card>
        <h3 style={S.h3}>📢 Últimas Atualizações</h3>
        <ul style={S.lista}>
          <li>Incluído acesso ao Novo Sistema ReATIVA em Sistemas Utilizados.</li>
          <li>Removido comunicado da Copa e reorganizada a tela inicial.</li>
          <li>Incluído alerta obrigatório de conferência no CRM antes do acionamento.</li>
        </ul>
      </Card>
    </>
  );
}

function CardAtalho({ emoji, titulo, desc, onClick }) {
  return (
    <button type="button" onClick={onClick} style={S.cardAtalho}>
      <span style={S.cardAtalhoEmoji}>{emoji}</span>
      <strong style={S.cardAtalhoTitulo}>{titulo}</strong>
      <span style={S.cardAtalhoDesc}>{desc}</span>
    </button>
  );
}

/* ===================== Política ===================== */

function SecaoPolitica() {
  return (
    <>
      <TituloSecao emoji="📄" titulo="Política Operacional" sub="Resumo das principais regras de cobrança e negociação para consulta rápida da equipe." />
      <Card>
        <h3 style={S.h3}>Regras gerais</h3>
        <ul style={S.lista}>
          <li>Cobrança após 31 dias de atraso.</li>
          <li>Confirmar os 3 dígitos do CPF antes da tratativa.</li>
          <li>Não realizar simulações sem autorização.</li>
          <li>Não utilizar número pessoal para contato.</li>
          <li>Não fazer "tratativa sobre tratativa".</li>
        </ul>
      </Card>
      <Card>
        <h3 style={S.h3}>Acordos e pagamentos</h3>
        <ul style={S.lista}>
          <li>Priorizar pagamento à vista ou cartão.</li>
          <li>Acordos quebrados: somente à vista/cartão, salvo exceção aprovada.</li>
          <li>Termo obrigatório quando aplicável.</li>
          <li>Não incluir matrícula quando houver regra de bloqueio vigente.</li>
        </ul>
      </Card>
      <Aviso>
        <strong>⚠️ Casos que não podem ser acionados.</strong> Se constar jurídico, cancelamento,
        restrição de contato ou qualquer bloqueio registrado no CRM, o aluno não deve ser acionado. Siga a
        orientação registrada no caso.
      </Aviso>
    </>
  );
}

/* ===================== Proposta de Exceção ===================== */

function SecaoExcecao() {
  return (
    <>
      <TituloSecao emoji="📝" titulo="Proposta de Exceção" sub="Orientações para solicitações que fogem da regra operacional vigente." />
      <Card>
        <h3 style={S.h3}>Quando utilizar</h3>
        <ul style={S.lista}>
          <li>Condição fora da política padrão.</li>
          <li>Entrada inferior à regra mínima.</li>
          <li>Prazo diferenciado ou situação com justificativa formal.</li>
          <li>Pedido que precisa de aprovação administrativa/supervisão.</li>
        </ul>
      </Card>
      <Card>
        <h3 style={S.h3}>O que deve conter</h3>
        <ul style={S.lista}>
          <li>Nome do aluno e CPF.</li>
          <li>Valor em aberto e condição proposta.</li>
          <li>Justificativa objetiva.</li>
          <li>Contexto relevante do caso.</li>
        </ul>
      </Card>
    </>
  );
}

/* ===================== Mensagens Prontas ===================== */

function BlocoCopiar({ titulo, texto }) {
  const [copiado, setCopiado] = useState(false);
  function copiar() {
    navigator.clipboard?.writeText(texto);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1800);
  }
  return (
    <Card>
      <h3 style={S.h3}>{titulo}</h3>
      <p style={S.paragrafo}>{texto}</p>
      <button type="button" onClick={copiar} style={S.botaoCopiar}>
        {copiado ? "✅ Copiado!" : "📋 Copiar"}
      </button>
    </Card>
  );
}

function SecaoMensagens() {
  return (
    <>
      <TituloSecao emoji="💬" titulo="Mensagens Prontas" sub="Modelos para apoiar a comunicação. Revise o caso no CRM antes de qualquer envio." />
      <Aviso>
        <strong>⚠️ Antes de enviar:</strong> nunca envie mensagem sem conferir se há tabulação, jurídico,
        cancelamento ou restrição de contato. A conferência no CRM vem antes do acionamento.
      </Aviso>

      <Card>
        <h3 style={S.h3}>✍️ Assinatura Gov.br</h3>
        <p style={S.paragrafo}>Como assinar um documento no Gov.br:</p>
        <ol style={S.listaOrdenada}>
          <li>Acesse o portal de assinatura do Gov.br.</li>
          <li>Faça login com seu CPF e senha da conta Gov.br.</li>
          <li>Clique em "Selecionar arquivo" e escolha o documento em PDF.</li>
          <li>Se desejar, escolha onde a assinatura ficará visível no documento.</li>
          <li>Clique em "Assinar documento" e confirme a operação.</li>
          <li>Após a assinatura, clique em "Baixar documento assinado" para salvar o arquivo.</li>
        </ol>
        <p style={S.observacao}>
          Observação: para utilizar a assinatura eletrônica, sua conta Gov.br deve ser nível Prata ou Ouro.
        </p>
      </Card>

      <BlocoCopiar
        titulo="📌 Confirmação de acordo"
        texto="Olá! Para darmos andamento corretamente, pedimos que confirme o acordo conforme orientação enviada. A confirmação é necessária para seguirmos com agilidade no procedimento."
      />
      <BlocoCopiar
        titulo="📎 Envio de comprovante"
        texto="Olá! Após realizar o pagamento, por gentileza encaminhe o comprovante para que possamos registrar e seguir com a baixa conforme o procedimento."
      />
    </>
  );
}

/* ===================== Objeções ===================== */

function SecaoObjecoes() {
  const itens = [
    { pergunta: "\u201cNão consigo pagar agora\u201d", resposta: "Entendo. Podemos avaliar a melhor alternativa dentro da política disponível para regularizar a situação." },
    { pergunta: "\u201cDepois eu vejo isso\u201d", resposta: "Compreendo, mas quanto antes resolvermos, mais controle você terá sobre valores, prazos e regularização." },
    { pergunta: "\u201cAchei o valor alto\u201d", resposta: "Vamos revisar a composição do débito e verificar a condição disponível conforme a política vigente." },
    { pergunta: "\u201cQuero pensar\u201d", resposta: "Claro. Apenas reforço que a condição pode depender da política e do prazo vigente." },
    { pergunta: "\u201cJá paguei, deve ser engano\u201d", resposta: "Sem problema, vou verificar o histórico no sistema. Pode me enviar o comprovante pra eu confirmar e regularizar rapidinho?" },
    { pergunta: "\u201cNão fui eu quem fez o acordo\u201d", resposta: "Entendo a dúvida. Vou confirmar os dados cadastrais com você antes de seguir, pra garantir que estamos falando com a pessoa certa." },
    { pergunta: "\u201cVou falar com meu advogado\u201d", resposta: "Sem problema, é um direito seu. Fico à disposição pra esclarecer qualquer ponto da negociação sempre que precisar." },
    { pergunta: "\u201cA universidade não me atendeu direito\u201d", resposta: "Sinto muito por isso. Posso registrar essa observação e, enquanto isso, seguir te ajudando a resolver a pendência financeira." },
    { pergunta: "\u201cNão reconheço essa dívida\u201d", resposta: "Entendo. Vou te passar os detalhes do débito (curso, período, valor) pra você conferir com calma antes de decidirmos o próximo passo." },
    { pergunta: "\u201cQuero desconto maior do que o oferecido\u201d", resposta: "Consigo trabalhar dentro da política vigente. Se for um caso específico, posso encaminhar como proposta de exceção pra análise." },
    { pergunta: "\u201cEstou desempregado(a)\u201d", resposta: "Sinto muito pela situação. Vamos ver juntos uma condição de prazo ou parcelamento que caiba no seu momento agora." },
    { pergunta: "\u201cJá fiz acordo antes e não deu certo\u201d", resposta: "Entendo a desconfiança. Dessa vez posso te acompanhar de perto pra garantir que tudo seja registrado e cumprido corretamente." },
  ];
  return (
    <>
      <TituloSecao emoji="🔥" titulo="Objeções" sub="Respostas base para contornar dúvidas e objeções durante a negociação." />
      {itens.map((it) => (
        <Card key={it.pergunta}>
          <h3 style={S.h3}>{it.pergunta}</h3>
          <p style={S.paragrafo}>{it.resposta}</p>
        </Card>
      ))}
    </>
  );
}

/* ===================== Dúvidas Frequentes ===================== */

function SecaoDuvidas() {
  const itens = [
    { p: "Posso acionar sem conferir o CRM?", r: "Não. A conferência do CRM é obrigatória antes de qualquer mensagem ou contato." },
    { p: "Quando não posso acionar?", r: "Quando houver jurídico, cancelamento, bloqueio, restrição de contato ou orientação registrada impedindo acionamento." },
    { p: "Comprovante de cartão deve ir onde?", r: "O comprovante deve ser salvo na pasta indicada e sinalizado conforme orientação operacional vigente." },
    { p: "E se o termo não funcionar?", r: "Encaminhe para a área responsável e sinalize no canal combinado para mapeamento e ajuste." },
  ];
  return (
    <>
      <TituloSecao emoji="❓" titulo="Dúvidas Frequentes" />
      {itens.map((it) => (
        <Card key={it.p}>
          <h3 style={S.h3}>{it.p}</h3>
          <p style={S.paragrafo}>{it.r}</p>
        </Card>
      ))}
    </>
  );
}

/* ===================== Honorários e Taxas ===================== */

function SecaoHonorarios() {
  return (
    <>
      <TituloSecao emoji="💰" titulo="Honorários e Taxas" />
      <div style={S.grade3}>
        <Card style={{ textAlign: "center" }}>
          <div style={S.numeroGrande}>8%</div>
          <div style={S.labelNumero}>Honorários</div>
          <p style={S.paragrafo}>Conforme política vigente para débitos acima de 30 dias.</p>
        </Card>
        <Card style={{ textAlign: "center" }}>
          <div style={S.numeroGrande}>1% a.m.</div>
          <div style={S.labelNumero}>Juros</div>
          <p style={S.paragrafo}>Conforme regra vigente.</p>
        </Card>
        <Card style={{ textAlign: "center" }}>
          <div style={S.numeroGrande}>2%</div>
          <div style={S.labelNumero}>Multa</div>
          <p style={S.paragrafo}>Conforme regra vigente.</p>
        </Card>
      </div>
    </>
  );
}

/* ===================== Meta de Honorários ===================== */

function SecaoMeta() {
  const faixas = [
    { faixa: "Até R$ 38.000,00", pct: "4%" },
    { faixa: "De R$ 38.000,01 a R$ 45.000,00", pct: "8%" },
    { faixa: "De R$ 45.000,01 a R$ 52.000,00", pct: "9%" },
    { faixa: "Acima de R$ 60.000,00", pct: "9,5%" },
  ];
  return (
    <>
      <TituloSecao emoji="🎯" titulo="Meta de Honorários" sub="Faixas de referência para acompanhamento do mês." />
      <Card>
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Faixa</th>
              <th style={S.thNum}>Percentual</th>
            </tr>
          </thead>
          <tbody>
            {faixas.map((f) => (
              <tr key={f.faixa}>
                <td style={S.td}>{f.faixa}</td>
                <td style={S.tdNum}>
                  <strong>{f.pct}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card>
        <h3 style={S.h3}>📌 Foco do mês</h3>
        <p style={S.paragrafo}>
          Trabalhar com organização, confirmar acordos, seguir os procedimentos corretos no Prime e manter
          registros completos no CRM para dar agilidade às baixas.
        </p>
      </Card>
    </>
  );
}

/* ===================== LGPD e Conduta ===================== */

function SecaoLgpd() {
  return (
    <>
      <TituloSecao emoji="🔐" titulo="LGPD e Conduta" />
      <Card>
        <h3 style={S.h3}>Proteção de dados</h3>
        <ul style={S.lista}>
          <li>Não compartilhar dados do aluno fora dos canais autorizados.</li>
          <li>Confirmar identificação antes de tratar informações financeiras.</li>
          <li>Não usar número pessoal para atendimento.</li>
        </ul>
      </Card>
      <Card>
        <h3 style={S.h3}>Conduta no acionamento</h3>
        <ul style={S.lista}>
          <li>Verificar histórico antes de acionar.</li>
          <li>Não acionar casos com jurídico, cancelamento ou bloqueio.</li>
          <li>Registrar a tratativa no CRM.</li>
        </ul>
      </Card>
    </>
  );
}

/* ===================== Indicadores ===================== */

function SecaoIndicadores() {
  const itens = [
    { emoji: "☎️", titulo: "Contatos", desc: "Volume e qualidade dos acionamentos." },
    { emoji: "🤝", titulo: "Acordos", desc: "Acordos confirmados e registrados." },
    { emoji: "🔗", titulo: "Links e termos", desc: "Pendências e retornos administrativos." },
    { emoji: "✅", titulo: "Baixas", desc: "Comprovantes e finalizações corretas." },
  ];
  return (
    <>
      <TituloSecao emoji="📊" titulo="Indicadores" />
      <div style={S.grade4}>
        {itens.map((it) => (
          <Card key={it.titulo} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>{it.emoji}</div>
            <h3 style={{ ...S.h3, marginBottom: 6 }}>{it.titulo}</h3>
            <p style={S.paragrafo}>{it.desc}</p>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ===================== Sistemas Utilizados ===================== */

function SecaoSistemas() {
  return (
    <>
      <TituloSecao emoji="🚀" titulo="Sistemas Utilizados" />
      <Card>
        <h3 style={S.h3}>🚀 Novo Sistema ReATIVA</h3>
        <p style={S.paragrafo}>
          CRM operacional da equipe Reativa para atendimentos, filas, links, termos, baixas e
          acompanhamento da operação.
        </p>
        <BotaoPrimario href="https://crm-reativa.vercel.app/">Acessar sistema</BotaoPrimario>
      </Card>
      <Card>
        <h3 style={S.h3}>📌 Prime</h3>
        <p style={S.paragrafo}>Utilizado para confirmação de acordos e procedimentos relacionados.</p>
      </Card>
    </>
  );
}

/* ===================== Biblioteca ===================== */

function SecaoBiblioteca({ ir }) {
  const itens = [
    { emoji: "📄", titulo: "Políticas", desc: "Regras vigentes e condições de negociação.", id: "politica" },
    { emoji: "💬", titulo: "Scripts", desc: "Mensagens prontas e modelos de atendimento.", id: "mensagens" },
    { emoji: "🔥", titulo: "Objeções", desc: "Apoio em negociações e recuperação de crédito.", id: "objecoes" },
    { emoji: "🧠", titulo: "Treinamento", desc: "Conteúdos da Universidade Ulbra e desenvolvimento da equipe." },
    { emoji: "📌", titulo: "Procedimentos", desc: "Termos, links, comprovantes e baixas." },
    { emoji: "💡", titulo: "Melhorias", desc: "Use o Painel de Sugestões para propor ajustes.", id: "sugestoes" },
  ];
  return (
    <>
      <TituloSecao emoji="📚" titulo="Biblioteca" />
      <div style={S.grade3}>
        {itens.map((it) => (
          <button
            key={it.titulo}
            type="button"
            onClick={() => it.id && ir(it.id)}
            style={{ ...S.cardAtalho, cursor: it.id ? "pointer" : "default" }}
          >
            <span style={S.cardAtalhoEmoji}>{it.emoji}</span>
            <strong style={S.cardAtalhoTitulo}>{it.titulo}</strong>
            <span style={S.cardAtalhoDesc}>{it.desc}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/* ===================== Contatos Úteis ===================== */

function SecaoContatos() {
  return (
    <>
      <TituloSecao emoji="☎️" titulo="Contatos Úteis" />
      <Card>
        <h3 style={S.h3}>Supervisão / Gestão</h3>
        <p style={S.paragrafo}>Dúvidas de política, exceções, conduta e direcionamentos operacionais.</p>
      </Card>
      <Card>
        <h3 style={S.h3}>Administrativo</h3>
        <p style={S.paragrafo}>Termos, links, comprovantes, ajustes e procedimentos administrativos.</p>
      </Card>
    </>
  );
}

/* ===================== Painel de Sugestões ===================== */

function SecaoSugestoes() {
  const [enviado, setEnviado] = useState(false);
  return (
    <>
      <TituloSecao emoji="💡" titulo="Painel de Sugestões" sub="Envie ideias, ajustes e melhorias para o Sistema ReATIVA ou para o Portal Reativa." />
      <Card>
        {enviado ? (
          <p style={S.paragrafo}>✅ Sugestão enviada, obrigado!</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setEnviado(true);
            }}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <Campo label="Nome">
              <input style={S.input} placeholder="Seu nome" />
            </Campo>
            <Campo label="Área">
              <select style={S.input}>
                <option value="">Selecione</option>
                <option>Sistema ReATIVA</option>
                <option>Portal Reativa</option>
              </select>
            </Campo>
            <Campo label="Tipo">
              <select style={S.input}>
                <option value="">Selecione</option>
                <option>Erro</option>
                <option>Melhoria</option>
                <option>Nova ideia</option>
                <option>Ajuste de informação</option>
                <option>Dúvida</option>
              </select>
            </Campo>
            <Campo label="Prioridade">
              <select style={S.input}>
                <option value="">Selecione</option>
                <option>Baixa</option>
                <option>Média</option>
                <option>Alta</option>
              </select>
            </Campo>
            <Campo label="Tela ou seção relacionada">
              <input style={S.input} placeholder="Ex: Minha Carteira" />
            </Campo>
            <Campo label="Descrição da sugestão">
              <textarea style={{ ...S.input, minHeight: 90 }} placeholder="Descreva sua sugestão..." />
            </Campo>
            <button type="submit" style={{ ...S.botaoPrimario, border: "none", cursor: "pointer" }}>
              Enviar sugestão
            </button>
          </form>
        )}
      </Card>
    </>
  );
}

function Campo({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={S.labelCampo}>{label}</span>
      {children}
    </label>
  );
}

/* ===================== Cultura Reativa ===================== */

function SecaoCultura() {
  const frases = [
    "Foco no objetivo, força para vencer.",
    "Juntos somos mais fortes.",
    "Disciplina hoje, resultados sempre.",
    "Pequenas atitudes, grandes resultados.",
    "Excelência é o nosso padrão.",
    "Faça seu melhor em tudo que fizer.",
    "Ideias inovam, atitudes transformam.",
    "Compromisso que gera confiança e resultados.",
    "Atendimento com excelência gera confiança; confiança gera acordos.",
  ];
  return (
    <>
      <TituloSecao emoji="💚" titulo="Cultura Reativa" sub="Frases, valores e lembretes para manter a equipe alinhada, motivada e focada em resultado." />
      <div style={S.grade3}>
        {frases.map((f) => (
          <Card key={f} style={{ ...S.cardFrase }}>
            <p style={S.frase}>&ldquo;{f}&rdquo;</p>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ===================== Nossa História ===================== */

function SecaoHistoria() {
  const cards = [
    { emoji: "📸", titulo: "Momento da equipe" },
    { emoji: "💚", titulo: "Campanha Reativa" },
    { emoji: "🏆", titulo: "Conquistas do mês" },
    { emoji: "✨", titulo: "Bastidores da operação" },
  ];
  return (
    <>
      <TituloSecao emoji="📸" titulo="Nossa História" sub="Momentos da equipe Reativa, conquistas, campanhas e bastidores." />
      <div style={S.grade4}>
        {cards.map((c) => (
          <div key={c.titulo} style={S.cardHistoria}>
            <span style={{ fontSize: 30 }}>{c.emoji}</span>
            <strong style={{ fontSize: 13 }}>{c.titulo}</strong>
          </div>
        ))}
      </div>
    </>
  );
}

/* ===================== Estilos ===================== */

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const VERDE = "#0f9d6b";
const VERDE_ESCURO = "#0b7d54";
const BORDA = "#e6eaf0";

const S = {
  pagina: { minHeight: "100%", background: "#f4f6fa", fontFamily: "Inter, system-ui, sans-serif" },
  shell: { display: "flex", minHeight: "100vh" },

  sidebar: {
    width: 260,
    flexShrink: 0,
    background: "linear-gradient(180deg, #0b1c14 0%, #0f2a1c 100%)",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    padding: "26px 18px",
  },
  logoBox: { fontFamily: FONTE_TITULO, fontSize: 22, fontWeight: 800, marginBottom: 2 },
  logoRe: { color: VERDE },
  logoAtiva: { color: "#fff" },
  logoSub: { fontSize: 12, color: "#8fb9a5", fontWeight: 600, marginBottom: 24 },

  nav: { flex: 1, overflowY: "auto" },
  navGrupo: { marginBottom: 18 },
  navGrupoLabel: { fontSize: 10.5, fontWeight: 800, letterSpacing: "0.1em", color: "#5f8a72", marginBottom: 6, paddingLeft: 10 },
  navItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: "#cfe3d7",
    padding: "8px 10px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    marginBottom: 2,
  },
  navItemAtivo: { background: "rgba(255,255,255,0.1)", color: "#fff" },

  sidebarRodape: { fontSize: 11.5, color: "#6f9a83", fontWeight: 600, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.08)" },

  conteudo: { flex: 1, padding: "36px 40px", maxWidth: 900 },

  hero: {
    background: "linear-gradient(135deg, #0b1c14 0%, #0f9d6b 140%)",
    borderRadius: 22,
    padding: "32px 34px",
    color: "#fff",
    marginBottom: 22,
    boxShadow: "0 24px 60px rgba(11,28,20,0.25)",
  },
  heroEyebrow: { fontSize: 11.5, fontWeight: 800, letterSpacing: "0.12em", color: "#bdf0da" },
  heroTitulo: { fontFamily: FONTE_TITULO, fontSize: 28, fontWeight: 800, margin: "10px 0 10px", letterSpacing: "-0.02em", lineHeight: 1.2 },
  heroTexto: { fontSize: 14.5, color: "#e3f5ec", lineHeight: 1.55, maxWidth: 620 },

  tituloSecaoBox: { marginBottom: 18 },
  tituloSecaoH1: { fontFamily: FONTE_TITULO, fontSize: 24, fontWeight: 800, color: "#0d1321", margin: 0, letterSpacing: "-0.02em" },
  tituloSecaoSub: { color: "#64748b", fontSize: 13.5, marginTop: 6 },

  card: { background: "#fff", border: `1px solid ${BORDA}`, borderRadius: 16, padding: "18px 20px", marginBottom: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  h3: { fontFamily: FONTE_TITULO, fontSize: 15.5, fontWeight: 700, color: "#0d1321", margin: "0 0 10px" },
  paragrafo: { color: "#475569", fontSize: 13.5, lineHeight: 1.6, margin: 0 },
  observacao: { color: "#8a93a3", fontSize: 12, marginTop: 10 },
  lista: { margin: 0, paddingLeft: 20, color: "#475569", fontSize: 13.5, lineHeight: 1.8 },
  listaOrdenada: { margin: 0, paddingLeft: 20, color: "#475569", fontSize: 13.5, lineHeight: 1.8 },

  aviso: { borderRadius: 14, padding: "14px 18px", marginBottom: 18, fontSize: 13.5, lineHeight: 1.6 },
  avisoAtencao: { background: "#fff7e6", border: "1px solid #f5c542", color: "#7c4a1e" },
  avisoInfo: { background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af" },

  botaoPrimario: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: VERDE,
    color: "#fff",
    padding: "10px 18px",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 13.5,
    textDecoration: "none",
    boxShadow: `0 10px 24px rgba(15,157,107,0.3)`,
  },
  botaoSecundario: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "#fff",
    color: "#334155",
    padding: "10px 18px",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 13.5,
    textDecoration: "none",
    border: `1px solid ${BORDA}`,
    cursor: "pointer",
  },
  botaoCopiar: {
    background: "#f1f5f9",
    color: "#334155",
    border: "none",
    borderRadius: 8,
    padding: "7px 14px",
    fontSize: 12.5,
    fontWeight: 700,
    cursor: "pointer",
  },

  grade4: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 18 },
  grade3: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 18 },

  cardAtalho: {
    background: "#fff",
    border: `1px solid ${BORDA}`,
    borderRadius: 16,
    padding: "18px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    textAlign: "left",
    cursor: "pointer",
    boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
  },
  cardAtalhoEmoji: { fontSize: 24 },
  cardAtalhoTitulo: { fontFamily: FONTE_TITULO, fontSize: 14.5, color: "#0d1321" },
  cardAtalhoDesc: { fontSize: 12.5, color: "#8a93a3" },

  numeroGrande: { fontFamily: FONTE_TITULO, fontSize: 32, fontWeight: 800, color: VERDE_ESCURO },
  labelNumero: { fontSize: 12, fontWeight: 700, color: "#8a93a3", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" },

  tabela: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "10px 12px", color: "#8a93a3", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${BORDA}` },
  thNum: { textAlign: "right", padding: "10px 12px", color: "#8a93a3", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${BORDA}` },
  td: { padding: "11px 12px", color: "#334155", fontSize: 13.5, borderBottom: "1px solid #f1f5f9" },
  tdNum: { padding: "11px 12px", color: VERDE_ESCURO, fontSize: 14, textAlign: "right", borderBottom: "1px solid #f1f5f9" },

  labelCampo: { fontSize: 12.5, fontWeight: 700, color: "#475569" },
  input: { padding: "9px 12px", borderRadius: 10, border: `1px solid ${BORDA}`, fontSize: 13.5, fontFamily: "inherit" },

  cardFrase: { background: "#f0fdf6", border: "1px solid #bdeed4" },
  frase: { fontFamily: FONTE_TITULO, fontSize: 14.5, color: VERDE_ESCURO, fontWeight: 700, margin: 0, lineHeight: 1.4 },

  cardHistoria: {
    background: "#fff",
    border: `1px solid ${BORDA}`,
    borderRadius: 16,
    padding: "26px 16px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    color: "#334155",
  },
};
