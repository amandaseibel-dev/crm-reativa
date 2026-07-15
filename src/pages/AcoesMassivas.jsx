import { useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const VERDE = "#0f9d6b";

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function converterValor(texto) {
  const limpo = String(texto || "").replace(/\./g, "").replace(",", ".").trim();
  const numero = Number(limpo);
  return Number.isFinite(numero) ? numero : null;
}

// Normaliza telefone pro formato 55DDDNUMERO (padrão internacional, sem
// espaço/símbolo, pronto pra ferramentas de disparo em massa). Trata os
// casos mais comuns de bagunça no cadastro: DDD duplicado, já ter o 55,
// e número de celular antigo sem o 9º dígito (completa automaticamente).
function normalizarTelefone(bruto) {
  let digitos = String(bruto || "").replace(/\D/g, "");
  if (!digitos) return null;

  // DDD duplicado tipo "(64) (64) 98122-6896" -> 6464981226896
  if (digitos.length === 13 && digitos.slice(0, 2) === digitos.slice(2, 4)) {
    digitos = digitos.slice(2);
  }
  if (digitos.length === 12 && digitos.slice(0, 2) === digitos.slice(2, 4) && digitos.slice(4, 5) !== "9") {
    digitos = digitos.slice(2);
  }

  // Separa o "55" (codigo do Brasil) do resto, se ja tiver.
  let temCodigoPais = false;
  let core = digitos;
  if (digitos.startsWith("55") && (digitos.length === 12 || digitos.length === 13)) {
    temCodigoPais = true;
    core = digitos.slice(2);
  }

  // Numero com 10 digitos (DDD + 8) esta sem o 9º dígito obrigatório do
  // celular -- completa. (Fixo teria os mesmos 10 dígitos, mas não recebe
  // WhatsApp mesmo, então não tem problema em "corrigir" ele também.)
  if (core.length === 10) {
    core = core.slice(0, 2) + "9" + core.slice(2);
  }

  if (core.length !== 11) {
    // Nao bateu em nenhum padrao esperado -- devolve mesmo assim, com 55
    // na frente, pra pelo menos nao quebrar o arquivo (mas pode precisar
    // de conferencia manual).
    return "55" + core;
  }

  return "55" + core;
}

export default function AcoesMassivas() {
  const [canal, setCanal] = useState("WHATSAPP"); // WHATSAPP | EMAIL
  const [valorMin, setValorMin] = useState("100,00");
  const [valorMax, setValorMax] = useState("");
  const [quantidade, setQuantidade] = useState("100");
  const [anoVencimento, setAnoVencimento] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [erro, setErro] = useState("");
  const [sucesso, setSucesso] = useState("");

  async function buscar() {
    setErro("");
    setSucesso("");
    const min = valorMin.trim() ? converterValor(valorMin) : null;
    const max = valorMax.trim() ? converterValor(valorMax) : null;
    const qtd = Math.max(1, Math.min(5000, Number(quantidade) || 100));

    if (valorMin.trim() && min === null) {
      setErro("Valor mínimo inválido.");
      return;
    }
    if (valorMax.trim() && max === null) {
      setErro("Valor máximo inválido.");
      return;
    }

    // Regra fixa: nunca gera ação pra caso com valor em aberto abaixo de
    // R$100 -- mesmo que o campo fique em branco ou alguém digite menos.
    const minEfetivo = Math.max(min ?? 0, 100);

    setCarregando(true);
    setResultados(null);

    try {
      // Se tiver filtro de ano de vencimento, busca primeiro quem tem
      // título nesse ano (SEM limite pequeno) -- senao o filtro de ano
      // acabava rodando só em cima de uma amostra pequena (a busca por
      // tempo sem contato já limitada), cortando quase tudo por engano.
      let idsComAnoVencimento = null;
      if (anoVencimento) {
        const inicioAno = `${anoVencimento}-01-01`;
        const fimAno = `${anoVencimento}-12-31`;
        const { data: titulosNoAno, error: erroTitulos } = await supabase
          .from("acordos_titulos")
          .select("aluno_id")
          .eq("situacao", "ABERTO")
          .gte("vencimento", inicioAno)
          .lte("vencimento", fimAno)
          .limit(20000);

        if (erroTitulos) throw erroTitulos;
        idsComAnoVencimento = [...new Set((titulosNoAno || []).map((t) => t.aluno_id))];

        if (idsComAnoVencimento.length === 0) {
          setResultados([]);
          setCarregando(false);
          return;
        }
      }

      // Prioriza por tempo sem contato (quem nunca foi acionado, ou faz
      // mais tempo, vem primeiro) -- mais saudavel pra base do que só
      // olhar valor. O valor continua disponível como filtro, só não é
      // mais o critério de ordenação.
      let query = supabase
        .from("alunos")
        .select("id, nome, telefone, email, data_ultimo_acionamento, responsavel_atual_email")
        .is("responsavel_atual_email", null)
        .order("data_ultimo_acionamento", { ascending: true, nullsFirst: true });

      // Se tem filtro de ano, já restringe pelos ids encontrados (evita
      // trazer um monte de gente fora do ano e cortar sem querer depois).
      if (idsComAnoVencimento) {
        query = query.in("id", idsComAnoVencimento.slice(0, 6000));
      }

      query = query.limit(Math.min(qtd * 3, 6000));

      const { data: alunosBrutos, error: erroAlunos } = await query;
      if (erroAlunos) throw erroAlunos;

      const idsAlunos = (alunosBrutos || []).map((a) => a.id);
      if (idsAlunos.length === 0) {
        setResultados([]);
        setCarregando(false);
        return;
      }

      // Busca o valor em aberto (casos, sem operador) só pra quem entrou
      // no lote acima, pra aplicar o filtro de valor min/max.
      const { data: casosBrutos, error: erroCasos } = await supabase
        .from("casos")
        .select("aluno_id, total_em_aberto")
        .in("aluno_id", idsAlunos)
        .is("operador_email", null);

      if (erroCasos) throw erroCasos;

      // Dedup por aluno_id, mantendo o maior valor quando houver duplicata.
      const valorPorAluno = new Map();
      for (const c of casosBrutos || []) {
        const atual = valorPorAluno.get(c.aluno_id) || 0;
        const novo = Number(c.total_em_aberto || 0);
        if (novo > atual) valorPorAluno.set(c.aluno_id, novo);
      }

      const lista = (alunosBrutos || [])
        .map((a) => ({
          alunoId: a.id,
          nome: a.nome || "-",
          telefoneBruto: a.telefone || "",
          telefoneFormatado: normalizarTelefone(a.telefone),
          email: (a.email || "").trim(),
          valor: valorPorAluno.get(a.id) || 0,
          diasSemContato: a.data_ultimo_acionamento
            ? Math.floor((Date.now() - new Date(a.data_ultimo_acionamento).getTime()) / 86400000)
            : null,
        }))
        .filter((l) => (canal === "WHATSAPP" ? !!l.telefoneFormatado : !!l.email)) // precisa do contato certo pro canal escolhido
        .filter((l) => l.valor >= minEfetivo)
        .filter((l) => (max === null ? true : l.valor <= max))
        .slice(0, qtd);

      setResultados(lista);
    } catch (e) {
      console.error("Erro ao buscar casos livres:", e);
      setErro("Erro ao buscar: " + (e.message || "tente novamente"));
    } finally {
      setCarregando(false);
    }
  }

  async function gerarEregistrar() {
    if (!resultados || resultados.length === 0) return;

    setGerando(true);
    setErro("");
    setSucesso("");

    try {
      // 1) Gera o Excel com as colunas certas pro canal escolhido.
      const linhas = resultados.map((r) =>
        canal === "WHATSAPP"
          ? { "Nome do aluno": r.nome, Telefone: r.telefoneFormatado }
          : { "Nome do aluno": r.nome, "E-mail": r.email }
      );
      const planilha = XLSX.utils.json_to_sheet(linhas);
      const livro = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(livro, planilha, "Ação Massiva");
      const nomeArquivo = `acao-massiva-${canal.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(livro, nomeArquivo);

      // 2) Registra a acao no sistema pra cada aluno: fica marcado que foi
      // estimulado por fora, com retorno agendado pra 10 dias.
      const { data: userData } = await supabase.auth.getUser();
      const email = userData?.user?.email || "";
      const { data: perfil } = await supabase
        .from("usuarios")
        .select("nome")
        .eq("email", email)
        .maybeSingle();
      const nomeUsuario = perfil?.nome || email;

      const agora = new Date();
      const retorno = new Date(agora);
      retorno.setDate(retorno.getDate() + 10);
      const retornoISO = retorno.toISOString().slice(0, 10);

      let falhas = 0;
      for (const r of resultados) {
        const { error: erroUpdate } = await supabase
          .from("alunos")
          .update({
            data_retorno: retornoISO,
            status_acionamento: "Ação massiva externa enviada — aguardando retorno",
            data_ultimo_acionamento: agora.toISOString(),
          })
          .eq("id", r.alunoId);

        const { error: erroMov } = await supabase.from("aluno_movimentacoes").insert({
          aluno_id: String(r.alunoId),
          tipo: canal === "WHATSAPP" ? "ACAO_MASSIVA_EXTERNA" : "ACAO_MASSIVA_EXTERNA_EMAIL",
          descricao: `Ação de estímulo enviada por fora do CRM via ${canal === "WHATSAPP" ? "WhatsApp" : "e-mail"} (planilha ${nomeArquivo}), sem operador vinculado. Retorno agendado para ${retorno.toLocaleDateString("pt-BR")}.`,
          registrado_por_nome: nomeUsuario,
          registrado_por_email: email,
          registrado_em: agora.toISOString(),
        });

        if (erroUpdate || erroMov) falhas += 1;
      }

      if (falhas > 0) {
        setSucesso(
          `Planilha gerada e ${resultados.length - falhas} de ${resultados.length} registrados. ${falhas} tiveram erro ao registrar (confira o console).`
        );
      } else {
        setSucesso(`Planilha gerada e ${resultados.length} aluno(s) registrados com retorno agendado para ${retorno.toLocaleDateString("pt-BR")}.`);
      }
    } catch (e) {
      console.error("Erro ao gerar/registrar ação massiva:", e);
      setErro("Erro ao gerar/registrar: " + (e.message || "tente novamente"));
    } finally {
      setGerando(false);
    }
  }

  const valorTotal = resultados ? resultados.reduce((s, r) => s + r.valor, 0) : 0;

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>⚡ Ações Massivas</h1>
          <p style={estilos.subtitulo}>
            Estimula por fora (fora do CRM) casos livres, sem operador vinculado — priorizado por
            tempo sem contato (quem nunca foi acionado, ou faz mais tempo, vem primeiro), sem depender
            de operador pra fazer o acionamento manual.
          </p>
        </div>
      </div>

      <div style={estilos.abas}>
        <button
          style={canal === "WHATSAPP" ? estilos.abaAtiva : estilos.aba}
          onClick={() => {
            setCanal("WHATSAPP");
            setResultados(null);
          }}
        >
          📱 WhatsApp
        </button>
        <button
          style={canal === "EMAIL" ? estilos.abaAtiva : estilos.aba}
          onClick={() => {
            setCanal("EMAIL");
            setResultados(null);
          }}
        >
          📧 E-mail
        </button>
      </div>
      {canal === "EMAIL" && (
        <p style={{ ...estilos.subtitulo, marginBottom: 14, marginTop: -8 }}>
          Pra tratar quem não tem telefone cadastrado, mas tem e-mail.
        </p>
      )}

      <div style={estilos.card}>
        <div style={estilos.linhaFiltros}>
          <div style={estilos.campo}>
            <label style={estilos.label}>Valor mínimo (nunca abaixo de R$ 100,00)</label>
            <input
              style={estilos.input}
              placeholder="Ex: 500,00"
              value={valorMin}
              onChange={(e) => setValorMin(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Valor máximo</label>
            <input
              style={estilos.input}
              placeholder="Ex: 3000,00"
              value={valorMax}
              onChange={(e) => setValorMax(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Quantidade</label>
            <input
              style={estilos.input}
              type="number"
              min="1"
              max="5000"
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Ano de vencimento da parcela</label>
            <select
              style={estilos.input}
              value={anoVencimento}
              onChange={(e) => setAnoVencimento(e.target.value)}
            >
              <option value="">Todos os anos</option>
              <option value="2023">2023</option>
              <option value="2024">2024</option>
              <option value="2025">2025</option>
              <option value="2026">2026</option>
            </select>
          </div>
        </div>

        {erro && <p style={estilos.erro}>{erro}</p>}
        {sucesso && <p style={estilos.sucesso}>{sucesso}</p>}

        <button style={estilos.botaoBuscar} onClick={buscar} disabled={carregando}>
          {carregando ? "Buscando..." : "Buscar prévia"}
        </button>
      </div>

      {resultados && (
        <div style={estilos.card}>
          <div style={estilos.resumoTopo}>
            <div>
              <strong style={{ fontFamily: FONTE_TITULO, fontSize: 18 }}>{resultados.length}</strong>{" "}
              <span style={{ color: "#8a93a3" }}>
                caso(s) livre(s) com {canal === "WHATSAPP" ? "telefone" : "e-mail"}, prontos pra ação
              </span>
              {resultados.length > 0 && (
                <span style={{ color: "#8a93a3" }}> · Total em aberto: {formatarMoeda(valorTotal)}</span>
              )}
            </div>
            {resultados.length > 0 && (
              <button style={estilos.botaoGerar} onClick={gerarEregistrar} disabled={gerando}>
                {gerando ? "Gerando..." : "⬇️ Gerar Excel e registrar ação"}
              </button>
            )}
          </div>

          {resultados.length === 0 ? (
            <p style={{ color: "#8a93a3" }}>
              Nenhum caso livre com esses filtros (ou sem {canal === "WHATSAPP" ? "telefone" : "e-mail"} cadastrado).
            </p>
          ) : (
            <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
              <table style={estilos.tabela}>
                <thead>
                  <tr>
                    <th style={estilos.th}>Nome do aluno</th>
                    <th style={estilos.th}>{canal === "WHATSAPP" ? "Telefone (formatado)" : "E-mail"}</th>
                    <th style={estilos.thNum}>Sem contato há</th>
                    <th style={estilos.thNum}>Valor em aberto</th>
                  </tr>
                </thead>
                <tbody>
                  {resultados.map((r) => (
                    <tr key={r.alunoId}>
                      <td style={estilos.td}>{r.nome}</td>
                      <td style={estilos.td}>{canal === "WHATSAPP" ? r.telefoneFormatado : r.email}</td>
                      <td style={estilos.tdNum}>
                        {r.diasSemContato === null ? (
                          <span style={{ color: "#b91c1c", fontWeight: 800 }}>Nunca acionado</span>
                        ) : (
                          `${r.diasSemContato} dia(s)`
                        )}
                      </td>
                      <td style={estilos.tdNum}>{formatarMoeda(r.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const estilos = {
  container: {
    padding: "28px 30px 40px",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "var(--rv-fundo, #f4f6fa)",
    minHeight: "100%",
  },
  cabecalho: { marginBottom: 18 },
  titulo: {
    margin: 0,
    color: "#0d1321",
    fontFamily: FONTE_TITULO,
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  subtitulo: { margin: "5px 0 0", color: "#8a93a3", fontSize: 13.5, maxWidth: 640 },
  abas: { display: "flex", gap: 8, marginBottom: 6 },
  aba: {
    background: "#fff",
    border: "1px solid #e3e7ee",
    borderRadius: 10,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 700,
    color: "#475569",
    cursor: "pointer",
  },
  abaAtiva: {
    background: "#0f9d6b",
    border: "1px solid #0f9d6b",
    borderRadius: 10,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 800,
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(15,157,107,0.35)",
  },
  card: {
    background: "#fff",
    borderRadius: 16,
    padding: "20px 22px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
    border: "1px solid #edf0f5",
    marginBottom: 18,
  },
  linhaFiltros: { display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 },
  campo: { display: "flex", flexDirection: "column", gap: 5, minWidth: 160 },
  label: { fontSize: 12, fontWeight: 700, color: "#475569" },
  input: {
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13,
  },
  erro: { color: "#b91c1c", fontSize: 13, marginBottom: 10 },
  sucesso: { color: "#0f7a4f", fontSize: 13, marginBottom: 10, fontWeight: 700 },
  botaoBuscar: {
    background: VERDE,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 20px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  resumoTopo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 14,
  },
  botaoGerar: {
    background: "#0d1321",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 18px",
    fontWeight: 800,
    fontSize: 13,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(0,0,0,0.2)",
  },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    color: "#8a93a3",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    background: "#f8fafc",
    borderBottom: "1px solid #e3e7ee",
    position: "sticky",
    top: 0,
  },
  thNum: {
    textAlign: "right",
    padding: "10px 12px",
    color: "#8a93a3",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    background: "#f8fafc",
    borderBottom: "1px solid #e3e7ee",
    position: "sticky",
    top: 0,
  },
  td: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", color: "#344054" },
  tdNum: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", textAlign: "right", fontWeight: 700, color: "#101828" },
};
