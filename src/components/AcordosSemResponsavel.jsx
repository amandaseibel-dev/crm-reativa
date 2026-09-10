import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import Aluno from "../pages/Aluno";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";

// Acordo ATIVO que ninguem acompanha. Sao dois problemas diferentes na mesma
// lista, e por isso a coluna "situacao" existe:
//   SEM_FICHA -- o acordo existe e nao ha caso no CRM com aquele CPF. O aluno
//                nao aparece em tela nenhuma, e nao da pra atribuir a ninguem:
//                falta cadastrar a ficha antes.
//   SEM_DONO  -- a ficha existe e esta sem operador. Essa da pra resolver aqui.
//
// Em 10/09/2026 havia 594 acordos nessa condicao (R$ 4,7 mi), distribuidos a
// mao. A aba existe pra que a proxima remessa importada nao repita isso em
// silencio: acordo chega sem dono e hoje ninguem percebe.
const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function AcordosSemResponsavel({ aoAtualizarContagem }) {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [fichaId, setFichaId] = useState(null);
  const [atribuindo, setAtribuindo] = useState({});
  const emVooRef = useRef(false);

  const carregar = useCallback(async () => {
    if (emVooRef.current) return;
    emVooRef.current = true;
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("fila_acordos_sem_responsavel");
    emVooRef.current = false;
    setCarregando(false);
    if (error) {
      setErro("Não foi possível carregar os acordos sem responsável.");
      return;
    }
    setLista(data || []);
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  useEffect(() => {
    if (aoAtualizarContagem) aoAtualizarContagem(lista.length);
  }, [lista, aoAtualizarContagem]);

  async function atribuir(linha) {
    if (!linha.caso_id || !linha.quem_fechou_email) return;
    setAtribuindo((s) => ({ ...s, [linha.acordo_id]: true }));
    setAviso("");
    const { error } = await supabase.rpc("atribuir_acordo_sem_responsavel", {
      p_caso_id: linha.caso_id,
      p_email: linha.quem_fechou_email,
    });
    setAtribuindo((s) => ({ ...s, [linha.acordo_id]: false }));
    if (error) {
      setAviso("Não foi possível atribuir: " + (error.message || ""));
      return;
    }
    setAviso(`Devolvido para ${linha.quem_fechou_nome}.`);
    carregar();
  }

  const semFicha = lista.filter((l) => l.situacao === "SEM_FICHA");
  const semDono = lista.filter((l) => l.situacao === "SEM_DONO");
  const soma = (arr) => arr.reduce((t, l) => t + Number(l.saldo_aberto || 0), 0);

  if (carregando && !lista.length) {
    return <Carregando texto="Carregando acordos sem responsável…" />;
  }

  return (
    <div>
      <div style={A.topo}>
        <div>
          <h2 style={A.titulo}>Acordos sem responsável</h2>
          <p style={A.sub}>
            Acordo ativo que ninguém acompanha. Parcelas continuam vencendo e o aluno
            não está na carteira de nenhum operador.
          </p>
        </div>
        <div style={A.contadores}>
          <span style={A.contadorAcordos}>{semDono.length} sem operador</span>
          <span style={A.contadorAlunos}>{semFicha.length} sem ficha no CRM</span>
          <span style={A.contadorValor}>{moeda(soma(lista))} em aberto</span>
        </div>
      </div>

      <div style={A.barra}>
        <button type="button" style={A.btnGhost} onClick={carregar}>Atualizar</button>
      </div>

      {erro ? <div style={A.erroBox}>{erro}</div> : null}
      {aviso ? <div style={A.erroBox}>{aviso}</div> : null}

      {!lista.length ? (
        <p style={A.muted}>Nenhum acordo sem responsável. Todos têm operador.</p>
      ) : (
        <div style={A.card}>
          <table style={A.tabela}>
            <thead>
              <tr>
                <th style={A.th}>Situação</th>
                <th style={A.th}>Aluno</th>
                <th style={A.th}>CPF</th>
                <th style={A.thNum}>Em aberto</th>
                <th style={A.thNum}>Parcelas vencidas</th>
                <th style={A.thNum}>Atraso</th>
                <th style={A.th}>Quem fechou</th>
                <th style={A.th}></th>
              </tr>
            </thead>
            <tbody>
              {lista.map((l) => (
                <tr key={l.acordo_id}>
                  <td style={A.td}>
                    <span style={{ ...A.chip, ...(l.situacao === "SEM_FICHA" ? A.chipRej : A.chipPend) }}>
                      {l.situacao === "SEM_FICHA" ? "Sem ficha" : "Sem operador"}
                    </span>
                  </td>
                  <td style={A.td}>{l.aluno || "—"}</td>
                  <td style={A.td}>{l.cpf || "—"}</td>
                  <td style={A.tdNum}>{moeda(l.saldo_aberto)}</td>
                  <td style={A.tdNum}>{l.parcelas_vencidas || 0}</td>
                  <td style={A.tdNum}>{l.dias_atraso ? `${l.dias_atraso} d` : "—"}</td>
                  <td style={A.td}>
                    {l.quem_fechou_nome
                      ? <span style={A.resp}>{l.quem_fechou_nome}</span>
                      : <span style={A.respVazio}>sem registro</span>}
                  </td>
                  <td style={A.td}>
                    <div style={A.acoes}>
                      {l.aluno_id ? (
                        <button type="button" style={A.btnFicha} onClick={() => setFichaId(l.aluno_id)}>
                          Ficha
                        </button>
                      ) : null}
                      {/* So devolve quando ha registro de quem fechou: a regra da
                          gestao e que o acordo fica com quem o fechou. Sem esse
                          registro nao ha a quem devolver -- e a maioria dos
                          acordos importados nao tem. */}
                      {l.situacao === "SEM_DONO" && l.quem_fechou_email ? (
                        <button
                          type="button"
                          style={atribuindo[l.acordo_id] ? { ...A.btnConf, ...A.btnBusy } : A.btnConf}
                          disabled={!!atribuindo[l.acordo_id]}
                          onClick={() => atribuir(l)}
                        >
                          Devolver a quem fechou
                        </button>
                      ) : null}
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
