// REGISTRO DE ENVIO FEITO FORA DO CRM.
//
// Mora na aba Remessas porque é ali que a remessa nasce, e o envio é sempre
// sobre uma remessa: o arquivo que foi disparado É a lista.
//
// O PÚBLICO NÃO É PRESUMIDO. Ou se informa a lista de matrículas que recebeu,
// ou se declara que o envio cobriu a remessa inteira. Assumir que todo mundo
// da remessa foi acionado inflaria a base e, com ela, o resultado.
//
// A HORA PODE NÃO SER CONHECIDA, e nesse caso nenhuma é inventada: registra-se
// só a data. A consequência é assumida — contra uma foto do mesmo dia sem hora
// comprovada, o resultado daquele envio fica pendente até a foto seguinte.
import { useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";

const CONTEXTOS = {
  PROXIMO_VENCIMENTO: "Próximo ao vencimento",
  BOLETO_VENCIDO: "Boleto vencido",
};

const VAZIO = {
  aberto: false, lote: "", nome: "", canal: "EMAIL", contexto: "",
  enviada_em: "", publico: "", matriculas: "", hora_conhecida: true,
};

export default function RegistrarEnvioExterno({ carteira, remessas = [], aoRegistrar }) {
  const [f, setF] = useState(VAZIO);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [recibo, setRecibo] = useState(null);

  const campo = (k, v) => setF((x) => ({ ...x, [k]: v }));

  async function registrar() {
    const { lote, nome, canal, contexto, enviada_em, publico, matriculas } = f;
    if (!lote) { setErro("Escolha a remessa que foi enviada."); return; }
    if (!nome.trim()) { setErro("Dê um nome à ação."); return; }
    if (!contexto) { setErro("Escolha o contexto da ação."); return; }
    if (!enviada_em) { setErro("Informe a data do envio."); return; }
    if (!publico) { setErro("Diga quem recebeu: a remessa inteira ou uma lista."); return; }
    const lista = publico === "lista"
      ? matriculas.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
      : null;
    if (publico === "lista" && lista.length === 0) {
      setErro("Cole as matrículas que receberam."); return;
    }

    setOcupado(true); setErro(""); setRecibo(null);
    const { data, error } = await supabase.rpc("preventivo_acao_externa_registrar", {
      p_carteira_id: carteira.id,
      p_lote_id: lote,
      p_nome: nome.trim(),
      p_canal: canal,
      p_contexto: contexto,
      p_enviada_em: new Date(
        f.hora_conhecida ? enviada_em : `${enviada_em.slice(0, 10)}T00:00`).toISOString(),
      p_matriculas: lista,
      p_remessa_inteira: publico === "remessa",
      p_envio_precisao: f.hora_conhecida ? "DATA_E_HORA" : "DATA",
    });
    setOcupado(false);
    if (error) { setErro(error.message); return; }
    setF(VAZIO);
    setRecibo({
      nome: data.nome,
      incluidos: data.incluidos,
      informadas: data.matriculas_informadas ?? null,
      fora: data.fora_da_remessa || [],
    });
    aoRegistrar?.();
  }

  return (
    <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Envios feitos fora do CRM</h2>
          <p style={{ ...S.muted, marginTop: 6, fontSize: 12.5, maxWidth: 760 }}>
            O disparo já aconteceu por fora. Aqui só se registra o que foi feito, para que a
            redução do saldo depois dele possa ser medida. O módulo nunca finge que foi ele
            quem enviou.
          </p>
        </div>
        <button style={S.btnGhost} onClick={() => campo("aberto", !f.aberto)}>
          {f.aberto ? "Fechar" : "Registrar envio"}
        </button>
      </div>

      {erro && <div style={{ ...S.erroBox, marginTop: 12 }}>{erro}</div>}

      {recibo && (
        <div style={{ ...S.card, padding: 14, marginTop: 12, borderLeft: "3px solid var(--rv-verde-borda)", borderRadius: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            Registrado: {recibo.nome} — {recibo.incluidos} destinatários
          </div>
          {recibo.fora.length > 0 && (
            <div style={{ ...S.muted, fontSize: 12, marginTop: 4 }}>
              {recibo.fora.length} das {recibo.informadas} matrículas informadas não estão nesta
              remessa e ficaram de fora: <strong>{recibo.fora.join(", ")}</strong>
            </div>
          )}
        </div>
      )}

      {f.aberto && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14 }}>
          <div style={{ flexBasis: "100%" }}>
            <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Remessa enviada *</label>
            <select style={{ ...S.select, minWidth: 320 }} value={f.lote}
                    onChange={(e) => campo("lote", e.target.value)}>
              <option value="">— escolha —</option>
              {remessas.map((r) => <option key={r.lote_id || r.id} value={r.lote_id || r.id}>{r.nome}</option>)}
            </select>
          </div>

          <div>
            <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Nome da ação *</label>
            <input style={S.input} value={f.nome} placeholder="Ex.: E-mail de 02/10"
                   onChange={(e) => campo("nome", e.target.value)} />
          </div>

          <div>
            <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Canal *</label>
            <select style={S.select} value={f.canal} onChange={(e) => campo("canal", e.target.value)}>
              <option value="EMAIL">E-mail</option>
              <option value="WHATSAPP">WhatsApp</option>
            </select>
          </div>

          <div>
            <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Contexto *</label>
            <select style={S.select} value={f.contexto} onChange={(e) => campo("contexto", e.target.value)}>
              <option value="">— escolha —</option>
              {Object.entries(CONTEXTOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>

          <div>
            <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>
              {f.hora_conhecida ? "Enviada em *" : "Enviada no dia *"}
            </label>
            <input type={f.hora_conhecida ? "datetime-local" : "date"}
                   style={{ ...S.input, minWidth: 0 }}
                   value={f.hora_conhecida ? f.enviada_em : f.enviada_em.slice(0, 10)}
                   onChange={(e) => campo("enviada_em",
                     f.hora_conhecida ? e.target.value : `${e.target.value}T00:00`)} />
            <label style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 8, fontSize: 12 }}>
              <input type="checkbox" checked={!f.hora_conhecida} style={{ marginTop: 3 }}
                     onChange={(e) => campo("hora_conhecida", !e.target.checked)} />
              <span>
                Não sei a hora, só o dia
                <span style={{ ...S.muted, display: "block", fontSize: 11.5, maxWidth: 320 }}>
                  Nenhum horário é inventado. Contra uma foto do mesmo dia sem hora comprovada,
                  o resultado fica pendente até a foto seguinte.
                </span>
              </span>
            </label>
          </div>

          <div style={{ flexBasis: "100%" }}>
            <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Quem recebeu *</label>
            <select style={{ ...S.select, minWidth: 280 }} value={f.publico}
                    onChange={(e) => campo("publico", e.target.value)}>
              <option value="">— escolha —</option>
              <option value="remessa">A remessa inteira recebeu</option>
              <option value="lista">Só parte dela — vou colar as matrículas</option>
            </select>
            <p style={{ ...S.muted, marginTop: 6, fontSize: 11.5 }}>
              Nada é presumido: se o envio não cobriu a remessa toda, informe a lista — senão o
              resultado seria medido sobre gente que não recebeu.
            </p>
          </div>

          {f.publico === "lista" && (
            <div style={{ flexBasis: "100%" }}>
              <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>
                Matrículas que receberam
              </label>
              <textarea style={{ ...S.input, minHeight: 90, width: "100%" }} value={f.matriculas}
                        placeholder="Uma por linha, ou separadas por vírgula"
                        onChange={(e) => campo("matriculas", e.target.value)} />
            </div>
          )}

          <div style={{ flexBasis: "100%" }}>
            <button style={S.btnPrimario} disabled={ocupado} onClick={registrar}>
              {ocupado ? "Registrando…" : "Registrar envio"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
