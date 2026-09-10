import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import Aluno from "../pages/Aluno";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";

// O que a instituicao decidiu NAO cobrar. Sao tres decisoes diferentes que hoje
// se confundem numa coisa so ("protegido") e que a gestao pediu para analisar
// SEPARADAMENTE, porque cada uma tem dono e consequencia proprios.
//
// Nada aqui entra em giro, nivelamento ou fila de acionamento. A aba existe
// para conferir se a decisao ainda vale -- e em 10/09/2026 ela ja mostrou 130
// casos com a cobranca cancelada e um ACORDO ATIVO correndo em paralelo.
const MOTIVOS = [
  { chave: "CANCELAMENTO", rotulo: "Cancelamento de cobrança" },
  { chave: "NAO_ACIONAR", rotulo: "Não acionar" },
  { chave: "JURIDICO", rotulo: "Jurídico" },
];

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const data = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("pt-BR") : "—");

export default function ForaDaCobranca({ aoAtualizarContagem }) {
  const [motivo, setMotivo] = useState("CANCELAMENTO");
  const [lista, setLista] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [soComDivida, setSoComDivida] = useState(true);
  const [fichaId, setFichaId] = useState(null);
  const emVooRef = useRef(false);

  const carregar = useCallback(async () => {
    if (emVooRef.current) return;
    emVooRef.current = true;
    setCarregando(true);
    setErro("");
    const { data: linhas, error } = await supabase.rpc("fila_fora_da_cobranca", {
      p_motivo: null,
    });
    emVooRef.current = false;
    setCarregando(false);
    if (error) {
      setErro("Não foi possível carregar os casos fora da cobrança.");
      return;
    }
    setLista(linhas || []);
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  useEffect(() => {
    if (aoAtualizarContagem) {
      aoAtualizarContagem(lista.filter((l) => Number(l.valor_total || 0) > 0).length);
    }
  }, [lista, aoAtualizarContagem]);

  const doMotivo = lista.filter((l) => l.motivo === motivo);
  const visiveis = soComDivida
    ? doMotivo.filter((l) => Number(l.valor_total || 0) > 0)
    : doMotivo;
  const contaMotivo = (m) =>
    lista.filter((l) => l.motivo === m && Number(l.valor_total || 0) > 0).length;
  const somaVisivel = visiveis.reduce((t, l) => t + Number(l.valor_total || 0), 0);
  const comAcordo = visiveis.filter((l) => l.tem_acordo_ativo).length;

  if (carregando && !lista.length) {
    return <Carregando texto="Carregando casos fora da cobrança…" />;
  }

  return (
    <div>
      <div style={A.topo}>
        <div>
          <h2 style={A.titulo}>Fora da cobrança</h2>
          <p style={A.sub}>
            Casos que a instituição decidiu não cobrar. Não entram em giro, nivelamento
            nem fila de acionamento — a aba serve para conferir se a decisão ainda vale.
          </p>
        </div>
        <div style={A.contadores}>
          <span style={A.contadorAlunos}>{visiveis.length} casos</span>
          <span style={A.contadorValor}>{moeda(somaVisivel)}</span>
          {comAcordo ? (
            <span style={A.contadorAcordos}>{comAcordo} com acordo ativo</span>
          ) : null}
        </div>
      </div>

      <div style={A.barra}>
        {MOTIVOS.map((m) => (
          <button
            key={m.chave}
            type="button"
            style={motivo === m.chave ? A.btnGhost : A.btnGhostClaro}
            onClick={() => setMotivo(m.chave)}
          >
            {m.rotulo} ({contaMotivo(m.chave)})
          </button>
        ))}
        <label style={{ ...A.muted, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={soComDivida}
            onChange={(e) => setSoComDivida(e.target.checked)}
          />
          Só com dívida em aberto
        </label>
        <button type="button" style={A.btnGhostClaro} onClick={carregar}>Atualizar</button>
      </div>

      {erro ? <div style={A.erroBox}>{erro}</div> : null}

      {!visiveis.length ? (
        <p style={A.muted}>Nenhum caso neste motivo.</p>
      ) : (
        <div style={A.card}>
          <table style={A.tabela}>
            <thead>
              <tr>
                <th style={A.th}>Aluno</th>
                <th style={A.th}>Matrícula</th>
                <th style={A.thNum}>Total</th>
                <th style={A.thNum}>Mensalidade</th>
                <th style={A.thNum}>Acordo</th>
                <th style={A.th}>Status</th>
                <th style={A.th}>Responsável</th>
                <th style={A.th}>Últ. acionamento</th>
                <th style={A.th}></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => (
                <tr key={l.caso_id}>
                  <td style={A.td}>
                    {l.aluno || "—"}
                    {/* Cobranca cancelada com acordo vivo e a contradicao que
                        esta aba existe para expor. */}
                    {l.tem_acordo_ativo ? (
                      <span style={{ ...A.chip, ...A.chipPend, marginLeft: 8 }}>acordo ativo</span>
                    ) : null}
                  </td>
                  <td style={A.td}>{l.matricula || "—"}</td>
                  <td style={A.tdNum}>{moeda(l.valor_total)}</td>
                  <td style={A.tdNum}>{moeda(l.mensalidade)}</td>
                  <td style={A.tdNum}>{moeda(l.acordo)}</td>
                  <td style={A.td}>{l.status_acionamento || "—"}</td>
                  <td style={A.td}>{l.operador_nome}</td>
                  <td style={A.td}>{data(l.data_ultimo_acionamento)}</td>
                  <td style={A.td}>
                    <div style={A.acoes}>
                      <button type="button" style={A.btnFicha} onClick={() => setFichaId(l.aluno_id)}>
                        Ficha
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fichaId ? (
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <strong>Ficha do aluno</strong>
              <button type="button" style={A.btnGhostClaro} onClick={() => setFichaId(null)}>Fechar</button>
            </div>
            <div style={{ overflow: "auto" }}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
