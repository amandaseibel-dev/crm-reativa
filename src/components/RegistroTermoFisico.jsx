import { useEffect, useState, useCallback } from "react";
import { supabase } from "../services/supabase";
import { rotuloSituacaoTermoFisico, classificarErroTermoFisico, SITUACOES_TERMO_FISICO } from "../utils/termoFisico";

// Registro ADMINISTRATIVO da situação do termo físico. Não é tabulação e não
// é status operacional: não conta como contato, não renova fidelização, não
// muda retorno, fila nem situação financeira, e "arquivado" não comprova
// quitação nem gera baixa.
//
// QUEM VÊ: só a gestão (`podeVer`, vindo de `podeVerTudo`). Para a operação o
// componente não renderiza NADA e nem chama a RPC. Quem barra de verdade é o
// banco (`usuario_e_gestao()` dentro das RPCs e na RLS); o `podeVer` é só
// para não mostrar o componente a quem não pode usá-lo.
//
// FALTA DE PERMISSÃO x FALHA TÉCNICA (para a gestão):
//   - 42501 (sem permissão): o componente some. A gestão nunca deveria cair
//     aqui, então não há aviso para não confundir com erro.
//   - qualquer outra falha (migração ainda não aplicada, função ausente, rede,
//     erro de banco): o componente AVISA que o registro está indisponível.
//     Não some em silêncio.

function formatarQuando(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export default function RegistroTermoFisico({ alunoId, podeVer = false }) {
  const [estado, setEstado] = useState({ carregando: true, sumir: false, falha: null, situacao: null, eventos: [] });
  const [escolha, setEscolha] = useState("EM_ANDAMENTO");
  const [notificar, setNotificar] = useState(false);
  const [salvando, setSalvando] = useState(false);

  // Leitura: só chamada da RPC, nunca escreve estado de forma síncrona no efeito.
  const lerRegistro = useCallback(() => {
    return supabase.rpc("termo_fisico_ler", { p_aluno_id: String(alunoId) }).then(({ data, error }) => {
      if (error) {
        const tipo = classificarErroTermoFisico(error);
        return {
          carregando: false,
          sumir: tipo === "SEM_PERMISSAO",
          falha: tipo === "FALHA_TECNICA" ? `${error.code || "erro"}: ${error.message || ""}` : null,
          situacao: null,
          eventos: [],
        };
      }
      return {
        carregando: false,
        sumir: false,
        falha: null,
        situacao: data?.situacao || null,
        eventos: Array.isArray(data?.eventos) ? data.eventos : [],
      };
    });
  }, [alunoId]);

  // A ficha remonta este componente por aluno (key={alunoId}), então o estado
  // inicial já é "carregando" e nunca mostra o registro de outro aluno.
  useEffect(() => {
    if (!alunoId || !podeVer) return undefined;
    let vivo = true;
    lerRegistro().then((novo) => {
      if (vivo) setEstado(novo);
    });
    return () => {
      vivo = false;
    };
  }, [alunoId, podeVer, lerRegistro]);

  // Operação: nada. Não há chamada, não há aviso.
  if (!podeVer) return null;
  if (estado.carregando || estado.sumir) return null;

  async function registrar() {
    setSalvando(true);
    const { error } = await supabase.rpc("termo_fisico_registrar", {
      p_aluno_id: String(alunoId),
      p_situacao: escolha,
      p_notificar: notificar,
    });
    setSalvando(false);
    if (error) {
      const tipo = classificarErroTermoFisico(error);
      alert(
        tipo === "SEM_PERMISSAO"
          ? "Você não tem permissão para registrar o termo físico."
          : "Registro do termo físico indisponível agora. Nada foi gravado. Avise a TI (" +
              (error.code || "erro") + ")."
      );
      return;
    }
    setNotificar(false);
    setEstado(await lerRegistro());
  }

  const caixa = {
    border: "1px solid #7c3aed",
    background: "#f5f3ff",
    borderRadius: 8,
    padding: 12,
    margin: "10px 0",
  };

  if (estado.falha) {
    return (
      <section aria-label="Termo físico (administrativo)" role="status" style={{ ...caixa, borderColor: "#b45309", background: "#fffbeb" }}>
        <div style={{ fontWeight: 700, color: "#92400e" }}>
          Registro do termo físico indisponível
        </div>
        <div style={{ fontSize: 13, marginTop: 4 }}>
          Não é erro do aluno nem da sua conta. O recurso ainda não está disponível neste ambiente, ou houve falha técnica.
          Avise a TI. Detalhe técnico: <code>{estado.falha}</code>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Termo físico (administrativo)" style={caixa}>
      <div style={{ fontWeight: 700, color: "#5b21b6", marginBottom: 6 }}>
        Termo físico · registro administrativo
      </div>
      <div style={{ marginBottom: 8 }}>
        Situação atual: <strong>{rotuloSituacaoTermoFisico(estado.situacao)}</strong>
      </div>

      {estado.eventos.length > 0 && (
        <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13 }}>
          {estado.eventos.map((ev) => (
            <li key={ev.id}>
              {formatarQuando(ev.registrado_em)} · {rotuloSituacaoTermoFisico(ev.situacao)} · {ev.autor_email}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={escolha} onChange={(e) => setEscolha(e.target.value)} disabled={salvando}>
          <option value="EM_ANDAMENTO">{SITUACOES_TERMO_FISICO.EM_ANDAMENTO}</option>
          <option value="ARQUIVADO">{SITUACOES_TERMO_FISICO.ARQUIVADO}</option>
        </select>
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={notificar} onChange={(e) => setNotificar(e.target.checked)} disabled={salvando} />{" "}
          Notificar a gestão
        </label>
        <button type="button" onClick={registrar} disabled={salvando}>
          {salvando ? "Registrando..." : "Registrar"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
        Não é tabulação: não altera contato, retorno, fila, fidelização nem situação financeira. Arquivado não comprova quitação.
      </div>
    </section>
  );
}
