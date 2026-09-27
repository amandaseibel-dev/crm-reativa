import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando, Erro, Vazio } from "../ui/estados";
import { cartaoEscuro } from "../ui/cards";
import AcordosPorResponsavel from "../components/AcordosPorResponsavel";
import {
  DESTINOS,
  O_QUE_MUDA,
  O_QUE_NAO_MUDA,
  acordosDeTerceiros,
  agruparConflitos,
  classeEmAlerta,
  opcoesResponsavel,
  rotuloResponsavel,
  resumoDeLinhas,
  casosPorAluno,
  casosNaoMarcados,
  totalPaginas,
  consolidarPorAno,
  moeda,
  rotuloClasse,
  validarConfirmacao,
} from "../utils/carteiraGeral";

// ============================================================================
// CARTEIRA GERAL — destino operacional de gestão e remanejamento em lote.
//
// Acesso: os três logins individuais da gestão (Amanda gestora, Fernanda,
// Amanda ADM). Não existe senha compartilhada: a Carteira Geral é um DESTINO,
// não um usuário que se loga. O portão definitivo é do banco
// (public.calibragem_e_gestao, checado em toda RPC daqui).
//
// Fluxo obrigatório: filtrar → selecionar → PRÉVIA → conferir → confirmar.
// A tela nunca move nada direto: ela pede a prévia, mostra o que muda e só
// então chama carteira_geral_mover com o id daquela prévia.
// ============================================================================

const POR_PAGINA = 200;

export default function CarteiraGeral() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");

  const [painel, setPainel] = useState(null);
  const [lista, setLista] = useState([]);
  const [operadores, setOperadores] = useState([]);
  // Quem aparece no filtro Responsável. Vem do painel, não de `usuarios`:
  // operador desligado que ainda tem caso PRECISA aparecer, senão a carteira
  // dele fica inalcançável (ver opcoesResponsavel em utils/carteiraGeral.js).
  const [donosComCaso, setDonosComCaso] = useState([]);
  // quem está logado, para a seção de acordos abrir em "Meus acordos"
  const [meuEmail, setMeuEmail] = useState("");

  const [filtros, setFiltros] = useState({
    responsavel: "", ano: "", tipo: "", busca: "", incluirEncerrados: false,
  });
  // Página da lista. A lista é por CASO, e o offset vai para a RPC.
  const [paginaAtual, setPaginaAtual] = useState(0);
  // aluno_id -> a LINHA inteira. Guardar a linha (e não só o id) é o que
  // mantém o total de selecionados correto depois de trocar de página.
  const [selecionados, setSelecionados] = useState(() => new Map());

  const [destinoTipo, setDestinoTipo] = useState("CARTEIRA_GERAL");
  const [destinoEmail, setDestinoEmail] = useState("");
  const [moverAcordos, setMoverAcordos] = useState(true);
  // Acordo de terceiro só vai se o id estiver aqui. Decisão item a item.
  const [acordosEscolhidos, setAcordosEscolhidos] = useState(() => new Set());
  const [motivo, setMotivo] = useState("");

  const [previa, setPrevia] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const emVooRef = useRef(false);

  useEffect(() => {
    let vivo = true;
    supabase.auth.getUser().then(({ data }) => {
      const e = data?.user?.email;
      if (vivo && e) setMeuEmail(String(e).toLowerCase());
    });
    return () => { vivo = false; };
  }, []);

  const carregarOperadores = useCallback(async () => {
    const { data } = await supabase
      .from("usuarios")
      .select("email, nome, perfil, ativo, recebe_novos_casos")
      .eq("ativo", true)
      .eq("perfil", "operador")
      .order("nome");
    if (Array.isArray(data)) setOperadores(data);
  }, []);

  async function alternarRecebimento(op) {
    const fechar = op.recebe_novos_casos !== false;
    const motivoEntrada = window.prompt(
      fechar
        ? `Fechar a entrada de casos novos de ${op.nome}?\n\nEla para de receber por rotina automática E de assumir da fila livre.\nNão perde o que já é dela. Motivo:`
        : `Reabrir a entrada de casos novos de ${op.nome}? Motivo:`
    );
    if (motivoEntrada === null) return;

    setOcupado(true);
    const { error } = await supabase.rpc("carteira_geral_definir_recebimento", {
      p_operador_email: op.email,
      p_recebe: !fechar,
      p_motivo: motivoEntrada,
    });
    setOcupado(false);
    if (error) {
      setAviso("Não foi possível mudar: " + (error.message || ""));
      return;
    }
    setAviso(`${op.nome}: entrada de casos novos ${fechar ? "fechada" : "reaberta"}.`);
    carregarOperadores();
  }

  const filtrosRpc = useMemo(
    () => ({
      responsavel: filtros.responsavel || null,
      ano: filtros.ano ? Number(filtros.ano) : null,
      tipo: filtros.tipo || null,
      busca: filtros.busca || null,
      incluir_encerrados: filtros.incluirEncerrados === true,
    }),
    [filtros]
  );

  const carregar = useCallback(async () => {
    if (emVooRef.current) return;
    emVooRef.current = true;
    setCarregando(true);
    setErro("");

    const [{ data: p, error: e1 }, { data: l, error: e2 }] = await Promise.all([
      supabase.rpc("carteira_geral_painel", { p_filtros: filtrosRpc }),
      supabase.rpc("carteira_geral_listar", {
        p_filtros: filtrosRpc, p_limite: POR_PAGINA, p_offset: paginaAtual * POR_PAGINA,
      }),
    ]);

    emVooRef.current = false;
    setCarregando(false);

    if (e1 || e2) {
      setErro((e1 || e2).message || "Não foi possível carregar a Carteira Geral.");
      return;
    }
    setPainel(p || null);
    // Só atualiza a lista de opções quando o painel veio do universo inteiro.
    // Com um responsável filtrado, `por_responsavel` traz só ele — e o seletor
    // ficaria com uma opção só, sem volta.
    if (!filtrosRpc.responsavel) setDonosComCaso(opcoesResponsavel(p?.por_responsavel));
    setLista(Array.isArray(l) ? l : []);
    // A seleção NÃO é limpa aqui: trocar de página tem de preservá-la. Quem
    // limpa é o efeito abaixo, que observa `filtrosRpc` — filtro novo é outro
    // universo, e seleção de um universo não vale no outro.
    setPrevia(null);
  }, [filtrosRpc, paginaAtual]);


  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar();
  }, [carregar]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregarOperadores();
  }, [carregarOperadores]);

  const porAno = useMemo(() => consolidarPorAno(painel?.por_ano), [painel]);
  const conflitos = useMemo(() => agruparConflitos(previa?.conflitos), [previa]);
  const terceiros = useMemo(() => acordosDeTerceiros(previa?.conflitos), [previa]);

  function alternarAcordo(acordoId) {
    setAcordosEscolhidos((atual) => {
      const novo = new Set(atual);
      if (novo.has(acordoId)) novo.delete(acordoId);
      else novo.add(acordoId);
      return novo;
    });
  }

  // Trocar filtro é trocar de universo: volta para a primeira página e esvazia
  // a seleção. Fica aqui, no evento, e não num efeito sobre `filtrosRpc` --
  // setState dentro de efeito é o que derrubou o CI da main em 25/09.
  function mudarFiltro(patch) {
    setFiltros((atual) => ({ ...atual, ...patch }));
    setPaginaAtual(0);
    setSelecionados(new Map());
    setPrevia(null);
  }

  function alternar(alunoId) {
    setSelecionados((atual) => {
      const novo = new Map(atual);
      if (novo.has(alunoId)) novo.delete(alunoId);
      else {
        const linha = lista.find((l) => l.aluno_id === alunoId);
        if (linha) novo.set(alunoId, linha);
      }
      return novo;
    });
    setPrevia(null);
  }

  // "Selecionar todos" vale só para ESTA página: marcar 30 mil casos de uma vez
  // não é uma decisão que a gestão deva tomar num clique.
  function alternarTodos() {
    setSelecionados((atual) => {
      const novo = new Map(atual);
      const todosDaPagina = lista.every((l) => novo.has(l.aluno_id)) && lista.length > 0;
      for (const l of lista) {
        if (todosDaPagina) novo.delete(l.aluno_id);
        else novo.set(l.aluno_id, l);
      }
      return novo;
    });
    setPrevia(null);
  }

  async function gerarPrevia() {
    const check = validarConfirmacao({
      destinoTipo,
      destinoEmail,
      motivo: motivo || "conferência",
      selecionados: [...selecionados.keys()],
    });
    if (!check.ok) {
      setAviso(check.erro);
      return;
    }

    setOcupado(true);
    setAviso("");
    const { data, error } = await supabase.rpc("carteira_geral_previa", {
      p_aluno_ids: [...selecionados.keys()],
      p_destino_tipo: destinoTipo,
      p_destino_email: destinoTipo === "OPERADOR" ? destinoEmail : null,
      p_mover_acordos: moverAcordos,
      p_filtros: filtrosRpc,
      p_acordo_ids: [...acordosEscolhidos],
    });
    setOcupado(false);

    if (error) {
      setAviso("Não foi possível gerar a prévia: " + (error.message || ""));
      return;
    }
    setPrevia(data || null);
  }

  async function confirmar() {
    const check = validarConfirmacao({
      destinoTipo,
      destinoEmail,
      motivo,
      selecionados: [...selecionados.keys()],
    });
    if (!check.ok) {
      setAviso(check.erro);
      return;
    }
    if (!previa?.previa_id) {
      setAviso("Gere a prévia antes de confirmar.");
      return;
    }

    // Casos que entram por pertencerem a um aluno marcado, sem terem sido
    // marcados na lista. Foi assim que 2 casos encerrados entraram no lote
    // 559b20bb sem aparecer na tela: a confirmação não dizia.
    const marcadosIds = new Set([...selecionados.values()].map((l) => l.caso_id).filter(Boolean));
    const extras = casosNaoMarcados(previa, marcadosIds);

    const ok = window.confirm(
      `Mover ${previa.total_alunos} aluno(s) — ${previa.total_casos ?? previa.total_alunos} caso(s) — ` +
        `${moeda(previa.total_valor)} — para ${previa.destino_nome}?\n\n` +
        (extras.total
          ? `ATENÇÃO: ${extras.total} caso(s) NÃO marcado(s) na lista vão junto, por serem do mesmo ` +
            `aluno` +
            (extras.encerrados ? ` (${extras.encerrados} encerrado(s), que a lista não mostra)` : "") +
            `.\nAlunos: ${extras.nomes.join(", ")}\n\n`
          : "") +
        `Acordos que vão junto: ${previa.total_acordos}` +
        (previa.acordos_de_terceiros
          ? ` (${previa.acordos_de_terceiros_selecionados} de ${previa.acordos_de_terceiros} de terceiros, selecionados por você)`
          : "") + ".\n" +
        `Retornos agendados preservados: ${previa.retornos_preservados}.\n\n` +
        "Isso muda de quem é o caso. Não muda pagamento, baixa, valor nem quem negociou."
    );
    if (!ok) return;

    setOcupado(true);
    const { data, error } = await supabase.rpc("carteira_geral_mover", {
      p_previa_id: previa.previa_id,
      p_motivo: motivo,
    });
    setOcupado(false);

    if (error) {
      setAviso("Não foi possível mover: " + (error.message || ""));
      return;
    }

    const recusados = Number(data?.total_recusados || 0);
    setAviso(
      `${data?.alunos_movidos || 0} aluno(s) e ${data?.acordos_movidos || 0} acordo(s) movidos para ` +
        `${data?.destino_nome}. ${data?.retornos_preservados || 0} retorno(s) preservado(s). ` +
        `Lote ${data?.lote_id}.` +
        (recusados
          ? ` ${recusados} aluno(s) recusado(s) — nada deles foi movido, porque algo mudou depois da prévia.`
          : "")
    );
    setMotivo("");
    setAcordosEscolhidos(new Set());
    setSelecionados(new Map());
    carregar();
  }

  if (carregando) return <Carregando tema="escuro" />;
  if (erro) return <Erro texto={erro} onTentar={carregar} tema="escuro" />;

  const selecao = [...selecionados.keys()];
  // Resumo sobre as LINHAS guardadas, não sobre a página atual: continua certo
  // depois de trocar de página.
  const resumo = resumoDeLinhas([...selecionados.values()]);
  const fichasPorAluno = casosPorAluno(lista);
  const paginas = totalPaginas(painel?.total_casos ?? painel?.total_alunos, POR_PAGINA);
  const marcadosNestaPagina = lista.filter((l) => selecionados.has(l.aluno_id)).length;

  return (
    <div style={pagina}>
      <h1 style={titulo}>Carteira Geral</h1>
      <p style={subtitulo}>
        Destino de gestão. O que está aqui não é pego por rotina automática e nenhum operador
        consegue assumir sozinho — só sai por esta tela. Para devolver à operação, mande para a{" "}
        <strong>fila livre</strong>.
      </p>

      {/* ---------------- painel ---------------- */}
      <div style={grade}>
        <Bloco titulo="Total no filtro" valor={moeda(painel?.total_valor)} nota={`${painel?.total_alunos || 0} alunos`} />
        <Bloco titulo="Mensalidade" valor={moeda(painel?.total_mensalidade)} />
        <Bloco titulo="Acordo" valor={moeda(painel?.total_acordo)} />
        <Bloco
          titulo="Sem operador"
          valor={moeda(painel?.sem_operador?.valor)}
          nota={`${painel?.sem_operador?.alunos || 0} alunos`}
          alerta
        />
        <Bloco
          titulo="Responsável não é operador ativo"
          valor={moeda(painel?.responsavel_inativo?.valor)}
          nota={`${painel?.responsavel_inativo?.alunos || 0} alunos`}
          alerta
        />
        <Bloco
          titulo="Já na Carteira Geral"
          valor={moeda(painel?.na_carteira_geral?.valor)}
          nota={`${painel?.na_carteira_geral?.alunos || 0} alunos`}
        />
      </div>

      <section style={cartao}>
        <h2 style={secao}>Por ano de vencimento</h2>
        <p style={nota}>
          O valor por ano soma o total. A contagem de alunos, não: quem deve em 2025 e em 2026
          aparece nos dois anos.
        </p>
        <table style={tabela}>
          <thead>
            <tr>
              <th style={th}>Ano</th>
              <th style={thNum}>Mensalidade</th>
              <th style={thNum}>Acordo</th>
              <th style={thNum}>Total</th>
              <th style={thNum}>Títulos/parcelas</th>
            </tr>
          </thead>
          <tbody>
            {porAno.map((l) => (
              <tr key={l.ano}>
                <td style={td}>{l.ano ?? "sem data"}</td>
                <td style={tdNum}>{moeda(l.mensalidade)}</td>
                <td style={tdNum}>{moeda(l.acordo)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{moeda(l.valor)}</td>
                <td style={tdNum}>{l.itens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={cartao}>
        <h2 style={secao}>Por responsável</h2>
        <table style={tabela}>
          <thead>
            <tr>
              <th style={th}>Responsável</th>
              <th style={th}>Situação</th>
              <th style={thNum}>Alunos</th>
              <th style={thNum}>Mensalidade</th>
              <th style={thNum}>Acordo</th>
              <th style={thNum}>Total</th>
            </tr>
          </thead>
          <tbody>
            {(painel?.por_responsavel || []).map((r) => (
              <tr key={r.email || r.classe}>
                <td style={td}>{r.nome}</td>
                <td style={{ ...td, color: classeEmAlerta(r.classe) ? "var(--rv-ambar-texto)" : "var(--rv-texto-fraco)" }}>
                  {rotuloClasse(r.classe)}
                </td>
                <td style={tdNum}>{r.alunos}</td>
                <td style={tdNum}>{moeda(r.mensalidade)}</td>
                <td style={tdNum}>{moeda(r.acordo)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{moeda(r.valor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ---------------- filtros ---------------- */}
      <section style={cartao}>
        <h2 style={secao}>Filtrar</h2>
        <div style={linhaFiltros}>
          <label style={campo}>
            <span style={rotulo}>Responsável</span>
            <select
              value={filtros.responsavel}
              onChange={(e) => mudarFiltro({ responsavel: e.target.value })}
              style={input}
            >
              <option value="">Todos</option>
              <option value="SEM_OPERADOR">Sem operador (sem responsável nenhum)</option>
              <option value="SEM_DONO_ATIVO">Qualquer um sem operador ativo (agrupa vários)</option>
              <option value="CARTEIRA_GERAL">Carteira Geral</option>
              {donosComCaso.map((o) => (
                <option key={o.email} value={o.email}>
                  {rotuloResponsavel(o, operadores)}
                </option>
              ))}
            </select>
          </label>

          <label style={campo}>
            <span style={rotulo}>Ano de vencimento</span>
            <select value={filtros.ano} onChange={(e) => mudarFiltro({ ano: e.target.value })} style={input}>
              <option value="">Todos</option>
              {porAno.map((l) => (
                <option key={l.ano} value={l.ano ?? ""}>
                  {l.ano ?? "sem data"}
                </option>
              ))}
            </select>
          </label>

          <label style={campo}>
            <span style={rotulo}>Tipo de dívida</span>
            <select value={filtros.tipo} onChange={(e) => mudarFiltro({ tipo: e.target.value })} style={input}>
              <option value="">Mensalidade e acordo</option>
              <option value="MENSALIDADE">Somente mensalidade</option>
              <option value="ACORDO">Somente acordo</option>
            </select>
          </label>

          <label style={campo}>
            <span style={rotulo}>Nome, CPF ou matrícula</span>
            <input
              value={filtros.busca}
              onChange={(e) => mudarFiltro({ busca: e.target.value })}
              style={input}
              placeholder="buscar"
            />
          </label>

          {/* Caso encerrado fica FORA da lista por padrão. Sem este controle a
              gestão não tinha como vê-lo — e ele vai junto no remanejamento
              quando pertence a um aluno marcado. */}
          <label style={{ ...campo, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              data-testid="incluir-encerrados"
              checked={filtros.incluirEncerrados}
              onChange={(e) => mudarFiltro({ incluirEncerrados: e.target.checked })}
            />
            <span style={rotulo}>Mostrar também casos encerrados</span>
          </label>
        </div>
      </section>

      {/* ---------------- lista ---------------- */}
      <section style={cartao}>
        <h2 style={secao}>
          Selecionar{" "}
          <span style={nota} data-testid="contagem-selecao">
            ({selecao.length} aluno(s) selecionado(s) no total · {marcadosNestaPagina} de{" "}
            {lista.length} nesta página)
          </span>
        </h2>

        {resumo.alunos > 0 && (
          <p style={nota} data-testid="resumo-selecao">
            <strong>{resumo.alunos}</strong> aluno(s) selecionado(s) · <strong>{moeda(resumo.valor)}</strong>{" "}
            ({moeda(resumo.mensalidade)} de mensalidade + {moeda(resumo.acordo)} de acordo) ·{" "}
            <strong>{resumo.retornos}</strong> retorno(s) preservado(s) ·{" "}
            <strong>{resumo.acordosProprios}</strong> acordo(s) do dono atual vão junto ·{" "}
            <strong>{resumo.acordosTerceiros}</strong> de terceiros ficam (só vão se você marcar um a um na prévia).
          </p>
        )}

        {lista.length === 0 ? (
          <Vazio texto="Nenhum aluno com este filtro." tema="escuro" />
        ) : (
          <table style={tabela}>
            <thead>
              <tr>
                <th style={th}>
                  <input
                    type="checkbox"
                    aria-label="Selecionar todos"
                    checked={selecao.length === lista.length && lista.length > 0}
                    onChange={alternarTodos}
                  />
                </th>
                <th style={th}>Aluno</th>
                <th style={th}>Responsável</th>
                <th style={thNum}>Mensalidade</th>
                <th style={thNum}>Acordo</th>
                <th style={thNum}>Total</th>
                <th style={thNum}>Acordos</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((l) => (
                // chave pelo CASO: um aluno com duas fichas rende duas linhas,
                // e com a chave no aluno elas colidiriam.
                <tr key={l.caso_id || l.aluno_id}>
                  <td style={td}>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${l.nome}`}
                      checked={selecionados.has(l.aluno_id)}
                      onChange={() => alternar(l.aluno_id)}
                    />
                  </td>
                  <td style={td}>
                    {l.nome}
                    {fichasPorAluno.get(l.aluno_id) > 1 && (
                      <span style={nota} data-testid="marca-ficha-gemea">
                        {" "}· {fichasPorAluno.get(l.aluno_id)} fichas deste aluno — marcar uma leva
                        todas
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, color: classeEmAlerta(l.dono_classe) ? "var(--rv-ambar-texto)" : undefined }}>
                    {l.dono_classe === "SEM_OPERADOR" ? "Sem operador" : l.dono_nome || l.dono_email}
                  </td>
                  <td style={tdNum}>{moeda(l.saldo_mensalidade)}</td>
                  <td style={tdNum}>{moeda(l.saldo_acordo)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{moeda(l.saldo_total)}</td>
                  <td style={tdNum}>
                    {l.acordos_vivos || 0}
                    {l.acordos_de_outro_dono ? ` (${l.acordos_de_outro_dono} de outro dono)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Paginação real. Antes o offset era fixo em 0 e tudo acima de 200
            casos era inalcançável pela tela. A seleção atravessa as páginas. */}
        {paginas > 1 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setPaginaAtual((n) => Math.max(n - 1, 0))}
              disabled={paginaAtual === 0 || ocupado}
              style={botao}
            >
              Anterior
            </button>
            <span style={nota} data-testid="paginacao">
              Página {paginaAtual + 1} de {paginas} · {painel?.total_casos ?? lista.length} caso(s) no filtro
            </span>
            <button
              type="button"
              onClick={() => setPaginaAtual((n) => Math.min(n + 1, paginas - 1))}
              disabled={paginaAtual >= paginas - 1 || ocupado}
              style={botao}
            >
              Próxima
            </button>
            {selecao.length > 0 && (
              <span style={nota}>A seleção é mantida ao trocar de página.</span>
            )}
          </div>
        )}
      </section>

      {/* ---------------- entrada de casos novos ---------------- */}
      <section style={cartao}>
        <h2 style={secao}>Entrada de casos novos</h2>
        <p style={nota}>
          Recolher a carteira de alguém não adianta se a máquina devolver casos na manhã seguinte —
          nem se a própria pessoa se servir da fila livre. Fechar aqui corta as duas portas:
          distribuição automática (nivelamento das 09:20, reposição, calibragem) e auto-atribuição
          (fila livre, atendimento e receptivo). <strong>Não desativa a pessoa</strong> e não tira o
          que já é dela — para desligar de vez, é o cadastro em Usuários.
        </p>
        <table style={tabela}>
          <thead>
            <tr>
              <th style={th}>Operador</th>
              <th style={th}>Entrada</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {operadores.map((o) => {
              const fechada = o.recebe_novos_casos === false;
              return (
                <tr key={o.email}>
                  <td style={td}>{o.nome}</td>
                  <td style={{ ...td, color: fechada ? "var(--rv-ambar-texto)" : undefined }}>
                    {fechada ? "Fechada" : "Aberta"}
                  </td>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => alternarRecebimento(o)}
                      disabled={ocupado}
                      style={{ ...botao, padding: "5px 12px", background: fechada ? "#374151" : "var(--rv-azul)" }}
                    >
                      {fechada ? `Reabrir ${o.nome}` : `Fechar ${o.nome}`}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* ---------------- acordos por responsável ----------------
           Fica ANTES do remanejamento de caso de propósito: são duas
           titularidades diferentes, e quem chega procurando "meus acordos" não
           deve esbarrar antes no lote de casos. */}
      <AcordosPorResponsavel meuEmail={meuEmail} />

      {/* ---------------- movimentar ---------------- */}
      <section style={cartao}>
        <h2 style={secao}>Movimentar em lote</h2>

        <div style={linhaFiltros}>
          <label style={campo}>
            <span style={rotulo}>Destino</span>
            <select value={destinoTipo} onChange={(e) => { setDestinoTipo(e.target.value); setPrevia(null); }} style={input}>
              {DESTINOS.map((d) => (
                <option key={d.valor} value={d.valor}>
                  {d.rotulo}
                </option>
              ))}
            </select>
            <span style={nota}>{DESTINOS.find((d) => d.valor === destinoTipo)?.ajuda}</span>
          </label>

          {destinoTipo === "OPERADOR" && (
            <label style={campo}>
              <span style={rotulo}>Operador</span>
              <select value={destinoEmail} onChange={(e) => { setDestinoEmail(e.target.value); setPrevia(null); }} style={input}>
                <option value="">Selecione…</option>
                {operadores.map((o) => (
                  <option key={o.email} value={o.email}>
                    {o.nome}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label style={{ ...campo, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={moverAcordos}
              onChange={(e) => { setMoverAcordos(e.target.checked); setPrevia(null); }}
            />
            <span style={rotulo}>Levar os acordos do próprio dono</span>
          </label>
        </div>

        <p style={nota}>
          Esta opção vale só para os acordos <strong>do dono do caso</strong>. Desmarcar deixa o
          acordo com ele — e, quando o aluno não tem mensalidade em aberto, o sistema realinha a
          ficha ao dono do acordo ativo, ou seja, o aluno volta para o responsável antigo.
          <br />
          <strong>Acordo de terceiro nunca vai junto por padrão.</strong> Ele aparece um a um na
          prévia e só se move se você marcar.
        </p>

        <label style={{ ...campo, maxWidth: 640 }}>
          <span style={rotulo}>Motivo (fica na auditoria)</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            style={{ ...input, minHeight: 64 }}
            placeholder="Ex.: saída da Olga — carteira recolhida para redistribuição."
          />
        </label>

        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={gerarPrevia} disabled={ocupado || selecao.length === 0} style={botao}>
            {ocupado ? "Calculando…" : `Ver prévia de ${selecao.length} aluno(s)`}
          </button>
          <button
            type="button"
            onClick={confirmar}
            disabled={ocupado || !previa?.previa_id}
            style={{ ...botao, background: previa?.previa_id ? "var(--rv-verde-ok-fundo)" : "#374151" }}
          >
            Confirmar remanejamento
          </button>
        </div>

        {aviso && <p style={avisoTexto}>{aviso}</p>}
      </section>

      {/* ---------------- prévia ---------------- */}
      {previa && (
        <section style={{ ...cartao, borderLeft: "4px solid var(--rv-azul)" }}>
          <h2 style={secao}>Prévia — nada foi movido ainda</h2>

          <div style={grade}>
            <Bloco titulo="Alunos" valor={String(previa.total_alunos)} nota="distintos" />
            {/* CASO é o que se move de fato. Aluno com duas fichas conta 1 aluno
                e 2 casos — e o encerrado não aparece na lista acima. */}
            <Bloco
              titulo="Casos que se movem"
              valor={String(previa.total_casos ?? previa.total_alunos)}
              nota={
                Number(previa.total_casos ?? 0) > Number(previa.total_alunos ?? 0)
                  ? "mais casos que alunos: há ficha repetida"
                  : "um por aluno"
              }
            />
            <Bloco
              titulo="Casos encerrados incluídos"
              valor={String(previa.total_casos_encerrados || 0)}
              nota="não aparecem na lista"
              alerta={Number(previa.total_casos_encerrados || 0) > 0}
            />
            <Bloco titulo="Acordos que vão junto" valor={String(previa.total_acordos)} />
            <Bloco
              titulo="Acordos de terceiros"
              valor={`${previa.acordos_de_terceiros_selecionados || 0} de ${previa.acordos_de_terceiros || 0}`}
              nota="só por seleção"
              alerta={Number(previa.acordos_de_terceiros || 0) > 0}
            />
            <Bloco titulo="Retornos preservados" valor={String(previa.retornos_preservados || 0)} />
            <Bloco titulo="Valor total" valor={moeda(previa.total_valor)} />
            <Bloco titulo="Destino" valor={previa.destino_nome} />
          </div>

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12 }}>
            <div>
              <h3 style={secaoMenor}>O que muda</h3>
              <ul style={listaTexto}>
                {O_QUE_MUDA.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 style={secaoMenor}>O que não muda</h3>
              <ul style={listaTexto}>
                {O_QUE_NAO_MUDA.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>

          {terceiros.length > 0 && (
            <>
              <h3 style={secaoMenor}>
                Acordos de terceiros ({previa.acordos_de_terceiros_selecionados} de{" "}
                {previa.acordos_de_terceiros} selecionados)
              </h3>
              <p style={nota}>
                Cada um destes acordos é de outra pessoa. Marque só os que devem acompanhar o
                aluno; os demais ficam com quem os negociou. Marcar ou desmarcar refaz a prévia.
              </p>
              <table style={tabela}>
                <thead>
                  <tr>
                    <th style={th}>Levar</th>
                    <th style={th}>Acordo</th>
                    <th style={th}>Aluno</th>
                    <th style={th}>Responsável hoje</th>
                    <th style={th}>Status</th>
                    <th style={thNum}>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {terceiros.map((t) => (
                    <tr key={t.acordo_id}>
                      <td style={td}>
                        <input
                          type="checkbox"
                          aria-label={`Levar acordo ${t.numero} de ${t.aluno}`}
                          checked={acordosEscolhidos.has(t.acordo_id)}
                          onChange={() => alternarAcordo(t.acordo_id)}
                        />
                      </td>
                      <td style={td}>{t.numero || "sem número"}</td>
                      <td style={td}>{t.aluno}</td>
                      <td style={td}>{t.de_email || "ninguém"}</td>
                      <td style={td}>{t.status}</td>
                      <td style={tdNum}>{moeda(t.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" onClick={gerarPrevia} disabled={ocupado} style={{ ...botao, marginTop: 10 }}>
                Recalcular prévia com esta seleção
              </button>
            </>
          )}

          <h3 style={secaoMenor}>Conflitos e avisos</h3>
          {conflitos.length === 0 ? (
            <p style={nota}>Nenhum conflito nesta seleção.</p>
          ) : (
            <table style={tabela}>
              <thead>
                <tr>
                  <th style={th}>Aviso</th>
                  <th style={thNum}>Casos</th>
                  <th style={th}>Exemplos</th>
                </tr>
              </thead>
              <tbody>
                {conflitos.map((c) => (
                  <tr key={c.tipo}>
                    <td style={td}>{c.rotulo}</td>
                    <td style={tdNum}>{c.total}</td>
                    <td style={{ ...td, color: "var(--rv-texto-fraco)", fontSize: 12 }}>
                      {c.exemplos.join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function Bloco({ titulo, valor, nota: rodape, alerta }) {
  return (
    <div style={{ ...bloco, borderLeft: `3px solid ${alerta ? "var(--rv-ambar-texto)" : "var(--rv-azul)"}` }}>
      <span style={blocoTitulo}>{titulo}</span>
      <strong style={blocoValor}>{valor}</strong>
      {rodape && <span style={nota}>{rodape}</span>}
    </div>
  );
}

const pagina = { padding: "24px", color: "var(--rv-texto)", maxWidth: 1400, margin: "0 auto" };
const titulo = { fontSize: 24, fontWeight: 800, margin: "0 0 4px" };
const subtitulo = { margin: "0 0 20px", color: "var(--rv-texto-fraco)", maxWidth: 820, lineHeight: 1.5 };
const cartao = { ...cartaoEscuro, borderRadius: 12, padding: 16, marginBottom: 16 };
const secao = { fontSize: 16, fontWeight: 700, margin: "0 0 4px" };
const secaoMenor = { fontSize: 14, fontWeight: 700, margin: "16px 0 6px" };
const nota = { fontSize: 12, color: "var(--rv-texto-fraco)", display: "block", margin: "0 0 10px" };
const grade = { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 };
const bloco = { ...cartaoEscuro, borderRadius: 10, padding: "10px 14px", minWidth: 170, display: "flex", flexDirection: "column", gap: 2 };
const blocoTitulo = { fontSize: 12, color: "var(--rv-texto-fraco)", fontWeight: 600 };
const blocoValor = { fontSize: 18, fontWeight: 800 };
const tabela = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const th = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #374151", fontSize: 12, color: "var(--rv-texto-fraco)" };
const thNum = { ...th, textAlign: "right" };
const td = { padding: "6px 8px", borderBottom: "1px solid #1f2937" };
const tdNum = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const linhaFiltros = { display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" };
const campo = { display: "flex", flexDirection: "column", gap: 4, minWidth: 220 };
const rotulo = { fontSize: 12, fontWeight: 600, color: "var(--rv-texto-fraco)" };
const input = { padding: "7px 9px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#f3f4f6", boxSizing: "border-box" };
const botao = { padding: "9px 16px", borderRadius: 8, border: "none", background: "var(--rv-azul)", color: "#fff", fontWeight: 700, cursor: "pointer" };
const avisoTexto = { marginTop: 12, fontSize: 13, color: "var(--rv-ambar-texto)" };
const listaTexto = { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: "var(--rv-texto-fraco)" };
