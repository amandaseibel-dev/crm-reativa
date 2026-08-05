import { useEffect, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import Aluno from "../pages/Aluno";
import { modalBox as modalBox_import } from "../ui/cards";

// Casos sem valor em aberto calculado -- normalmente da carga retroativa
// antiga, que nunca teve o titulo processado direito. Aparecem aqui pra
// alguem conferir manualmente e preencher o valor certo.
export default function CasosSemValor({ aoAtualizarContagem }) {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [busca, setBusca] = useState("");
  const [valores, setValores] = useState({});
  const [salvando, setSalvando] = useState({});
  const [mensagem, setMensagem] = useState("");
  const [fichaId, setFichaId] = useState(null);
  // Impede chamadas simultaneas e cancela a requisicao anterior ao remontar/
  // desmontar. A RPC listar_casos_sem_valor e cara (~3s); duas cargas em voo
  // ao mesmo tempo so somam pressao no banco sem beneficio.
  const emVooRef = useRef(false);
  const abortRef = useRef(null);

  useEffect(() => {
    carregar();
    return () => {
      // Cancela a requisicao pendente ao desmontar (troca de aba/pagina).
      if (abortRef.current) abortRef.current.abort();
    };
    // Carga unica no mount (sob demanda ao abrir a aba); carregar e estavel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (aoAtualizarContagem) aoAtualizarContagem(lista.length);
  }, [lista, aoAtualizarContagem]);

  function ehAbort(erro) {
    // O postgrest-js nao lanca no abort (shouldThrowOnError=false): devolve
    // { error } com name/code de AbortError. Cobrimos os dois formatos (erro
    // como objeto do postgrest e como excecao real) para nunca logar cancelamento.
    const nome = erro?.name || "";
    const msg = erro?.message || "";
    const code = erro?.code || "";
    return nome === "AbortError" || code === "ABORT_ERR" || /AbortError/.test(msg);
  }

  async function carregar() {
    // Single-flight: mesma consulta ja em andamento -> ignora (nao duplica).
    if (emVooRef.current) return;
    emVooRef.current = true;

    // Cancela qualquer requisicao anterior ainda pendente antes de iniciar.
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setCarregando(true);

    try {
      const { data, error } = await supabase
        .rpc("listar_casos_sem_valor")
        .abortSignal(controller.signal);

      // Resposta antiga (desmontou/remontou/abortou): NUNCA atualiza o estado.
      if (controller.signal.aborted) return;

      if (error) {
        // Cancelamento nao e erro operacional: nao loga, nao mostra nada.
        if (ehAbort(error)) return;
        console.error("Erro ao carregar casos sem valor:", error);
        setCarregando(false);
        return;
      }

      setLista(data || []);
      setCarregando(false);
    } catch (e) {
      // Defensivo: se por algum motivo a chamada lancar, um abort e silencioso;
      // qualquer outro erro apenas para o spinner (sem quebrar a tela).
      if (controller.signal.aborted || ehAbort(e)) return;
      console.error("Erro ao carregar casos sem valor:", e);
      if (!controller.signal.aborted) setCarregando(false);
    } finally {
      // Garante liberar o single-flight mesmo em excecao, evitando travar
      // futuras cargas.
      emVooRef.current = false;
    }
  }

  async function salvarValor(aluno) {
    const bruto = valores[aluno.id];
    const numero = Number(String(bruto || "").replace(/\./g, "").replace(",", "."));

    if (!numero || numero <= 0) {
      alert("Informe um valor válido maior que zero.");
      return;
    }

    setSalvando((s) => ({ ...s, [aluno.id]: true }));

    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email || "";

    // Ja existe caso pra esse aluno? Atualiza; senao, cria. (limit(1) pra
    // nunca quebrar se por algum motivo tiver mais de uma linha)
    const { data: casosExistentes } = await supabase
      .from("casos")
      .select("id")
      .eq("aluno_id", aluno.id)
      .limit(1);
    const casoExistente = casosExistentes?.[0] || null;

    let erro = null;
    if (casoExistente) {
      const { error } = await supabase
        .from("casos")
        .update({
          total_em_aberto: numero,
          caso_atualizado_por: email,
          caso_atualizado_em: new Date().toISOString(),
        })
        .eq("id", casoExistente.id);
      erro = error;
    } else {
      const { error } = await supabase.from("casos").insert({
        aluno_id: aluno.id,
        nome_aluno: aluno.nome,
        cpf: aluno.cpf,
        total_em_aberto: numero,
        caso_atualizado_por: email,
        caso_atualizado_em: new Date().toISOString(),
      });
      erro = error;
    }

    setSalvando((s) => ({ ...s, [aluno.id]: false }));

    if (erro) {
      alert("Erro ao salvar valor: " + erro.message);
      return;
    }

    setMensagem(`Valor de ${aluno.nome} salvo. Ele já entra na fila de ações normalmente.`);
    setLista((atual) => atual.filter((a) => a.id !== aluno.id));
  }

  const filtrada = lista.filter((a) =>
    busca.trim() ? String(a.nome || "").toLowerCase().includes(busca.toLowerCase()) : true
  );

  if (carregando) {
    return <p style={{ padding: 16, opacity: 0.7 }}>Carregando casos sem valor...</p>;
  }

  return (
    <div style={{ padding: "4px 0" }}>
      <p style={{ fontSize: 13, color: "#8a93a3", marginBottom: 12 }}>
        Alunos que estão devendo (base ativa, sem responsável), mas o sistema nunca calculou o
        valor em aberto — normalmente vindos da carga retroativa antiga. Preencha o valor certo pra
        eles voltarem a aparecer nas listas e ações normalmente.
      </p>

      <input
        placeholder="Buscar por nome..."
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #e3e7ee", fontSize: 13, marginBottom: 12, width: 280 }}
      />

      <p style={{ fontSize: 12.5, color: "#8a93a3", marginBottom: 10 }}>
        <strong>{filtrada.length}</strong> de {lista.length} caso(s) sem valor
      </p>

      {mensagem && (
        <p style={{ color: "#0f7a4f", fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{mensagem}</p>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={th}>Nome</th>
              <th style={th}>CPF</th>
              <th style={th}>Matrícula</th>
              <th style={th}>Curso / Unidade</th>
              <th style={th}>Telefone</th>
              <th style={th}>Já teve contato?</th>
              <th style={th}>Status</th>
              <th style={th}>Valor correto</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {filtrada.slice(0, 200).map((a) => (
              <tr key={a.id}>
                <td style={td}>{a.nome}</td>
                <td style={td}>{a.cpf}</td>
                <td style={td}>{a.matricula || "-"}</td>
                <td style={td}>
                  {a.curso || "-"}
                  {a.unidade ? ` · ${a.unidade}` : ""}
                </td>
                <td style={td}>{a.telefone || "-"}</td>
                <td style={td}>
                  {a.ultima_movimentacao ? (
                    new Date(a.ultima_movimentacao).toLocaleDateString("pt-BR")
                  ) : (
                    <span style={{ color: "#b91c1c", fontWeight: 700 }}>Nunca</span>
                  )}
                </td>
                <td style={td}>{a.status_jornada}</td>
                <td style={td}>
                  <input
                    placeholder="Ex: 350,00"
                    value={valores[a.id] || ""}
                    onChange={(e) => setValores((v) => ({ ...v, [a.id]: e.target.value }))}
                    style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e3e7ee", fontSize: 13, width: 110 }}
                  />
                </td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button
                      onClick={() => salvarValor(a)}
                      disabled={salvando[a.id]}
                      style={{
                        background: "#1e40af",
                        color: "#fff",
                        border: "none",
                        borderRadius: 8,
                        padding: "6px 12px",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      {salvando[a.id] ? "Salvando..." : "Salvar"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFichaId(a.id)}
                      title="Abrir ficha completa do aluno (histórico, movimentações)"
                      style={{
                        background: "#fff",
                        color: "#475569",
                        border: "1px solid #e3e7ee",
                        borderRadius: 8,
                        padding: "6px 10px",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      Ver ficha
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtrada.length > 200 && (
          <p style={{ opacity: 0.6, fontSize: 12, marginTop: 8 }}>
            Mostrando 200 de {filtrada.length} — refine a busca pra achar mais rápido.
          </p>
        )}
      </div>

      {/* Ficha do aluno embutida (abre na mesma tela). */}
      {fichaId && (
        <div style={ovl} onClick={() => setFichaId(null)}>
          <div style={mbox} onClick={(e) => e.stopPropagation()}>
            <div style={mtopo}>
              <span style={{ fontWeight: 800, color: "#0d1321" }}>Ficha do aluno</span>
              <button type="button" style={mfechar} onClick={() => setFichaId(null)}>Fechar ✕</button>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const ovl = { position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "3vh 2vw", zIndex: 1000 };
const mbox = { ...modalBox_import, width: "min(1100px, 96vw)", maxHeight: "94vh", display: "flex", flexDirection: "column", overflow: "hidden" };
const mtopo = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #e6eaf0", background: "#f8fafc" };
const mfechar = { background: "#0f172a", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" };

const th = {
  textAlign: "left",
  padding: "8px 10px",
  color: "#8a93a3",
  fontSize: 10.5,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  background: "#f8fafc",
  borderBottom: "1px solid #e3e7ee",
};

const td = {
  padding: "8px 10px",
  borderBottom: "1px solid #f2f4f7",
};
