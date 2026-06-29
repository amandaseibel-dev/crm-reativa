import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function dinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function numeroMoeda(valor) {
  const texto = String(valor || "")
    .replace("R$", "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "")
    .trim();

  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : 0;
}

function pegarValorCaso(item) {
  return (
    item?.valor_cobranca_ajustado ??
    item?.valor_em_aberto ??
    item?.valor_aberto ??
    item?.valor_total ??
    item?.valor_divida ??
    item?.saldo_devedor ??
    item?.valor ??
    0
  );
}

export default function AjustesAlunoUnificado({ aluno, casos = [], onAtualizar }) {
  const [usuario, setUsuario] = useState(null);
  const [salvandoCadastro, setSalvandoCadastro] = useState(false);
  const [casoAberto, setCasoAberto] = useState(null);
  const [salvandoCaso, setSalvandoCaso] = useState(false);

  const [cadastro, setCadastro] = useState({
    nome_aluno_editado: "",
    cpf_referencia_editado: "",
    telefone_aluno: "",
    email_aluno: "",
    curso_aluno: "",
    unidade_aluno: "",
    observacao_cadastro: "",
  });

  const [ajusteCaso, setAjusteCaso] = useState({
    valor_cobranca_ajustado: "",
    motivo_ajuste_valor: "",
    cadastro_caso_observacao: "",
  });

  useEffect(() => {
    carregarUsuario();
  }, []);

  useEffect(() => {
    if (!aluno) return;

    setCadastro({
      nome_aluno_editado: aluno.nome_aluno_editado || aluno.nome_aluno || "",
      cpf_referencia_editado: aluno.cpf_referencia_editado || aluno.cpf_referencia || "",
      telefone_aluno: aluno.telefone_aluno || "",
      email_aluno: aluno.email_aluno || "",
      curso_aluno: aluno.curso_aluno || "",
      unidade_aluno: aluno.unidade_aluno || "",
      observacao_cadastro: aluno.observacao_cadastro || "",
    });
  }, [aluno]);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function registrarHistorico(payload) {
    await supabase.from("historico_alteracoes_crm").insert({
      chave_unificacao: aluno?.chave_unificacao || null,
      usuario_email: usuario?.email || "",
      ...payload,
    });
  }

  async function salvarCadastro() {
    if (!aluno?.chave_unificacao) {
      alert("Aluno unificado não localizado.");
      return;
    }

    setSalvandoCadastro(true);

    const antes = {
      nome_aluno_editado: aluno.nome_aluno_editado,
      cpf_referencia_editado: aluno.cpf_referencia_editado,
      telefone_aluno: aluno.telefone_aluno,
      email_aluno: aluno.email_aluno,
      curso_aluno: aluno.curso_aluno,
      unidade_aluno: aluno.unidade_aluno,
      observacao_cadastro: aluno.observacao_cadastro,
    };

    const depois = {
      nome_aluno_editado: cadastro.nome_aluno_editado || null,
      cpf_referencia_editado: cadastro.cpf_referencia_editado || null,
      telefone_aluno: cadastro.telefone_aluno || null,
      email_aluno: cadastro.email_aluno || null,
      curso_aluno: cadastro.curso_aluno || null,
      unidade_aluno: cadastro.unidade_aluno || null,
      observacao_cadastro: cadastro.observacao_cadastro || null,
      cadastro_atualizado_por: usuario?.email || "",
      cadastro_atualizado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("alunos_unificados")
      .update(depois)
      .eq("chave_unificacao", aluno.chave_unificacao);

    setSalvandoCadastro(false);

    if (error) {
      alert("Erro ao salvar cadastro: " + error.message);
      return;
    }

    await registrarHistorico({
      tipo_alteracao: "AJUSTE_CADASTRO_ALUNO",
      antes,
      depois,
      observacao: cadastro.observacao_cadastro || "Cadastro do aluno ajustado no CRM.",
    });

    alert("Cadastro do aluno atualizado no CRM.");

    if (onAtualizar) onAtualizar();
  }

  function abrirAjusteCaso(caso) {
    setCasoAberto(caso);

    setAjusteCaso({
      valor_cobranca_ajustado:
        caso.valor_cobranca_ajustado !== null && caso.valor_cobranca_ajustado !== undefined
          ? String(caso.valor_cobranca_ajustado).replace(".", ",")
          : "",
      motivo_ajuste_valor: caso.motivo_ajuste_valor || "",
      cadastro_caso_observacao: caso.cadastro_caso_observacao || "",
    });
  }

  async function salvarCaso() {
    if (!casoAberto) {
      alert("Selecione um caso.");
      return;
    }

    const registro = casoAberto.registro_unico;
    const id = casoAberto.id;

    if (!registro && !id) {
      alert("Não localizei o identificador do caso.");
      return;
    }

    if (!ajusteCaso.valor_cobranca_ajustado && !ajusteCaso.cadastro_caso_observacao) {
      alert("Informe o valor ajustado ou uma observação.");
      return;
    }

    setSalvandoCaso(true);

    const antes = {
      valor_cobranca_ajustado: casoAberto.valor_cobranca_ajustado,
      motivo_ajuste_valor: casoAberto.motivo_ajuste_valor,
      cadastro_caso_observacao: casoAberto.cadastro_caso_observacao,
    };

    const depois = {
      valor_cobranca_ajustado: ajusteCaso.valor_cobranca_ajustado
        ? numeroMoeda(ajusteCaso.valor_cobranca_ajustado)
        : null,
      motivo_ajuste_valor: ajusteCaso.motivo_ajuste_valor || null,
      cadastro_caso_observacao: ajusteCaso.cadastro_caso_observacao || null,
      valor_ajustado_por: usuario?.email || "",
      valor_ajustado_em: new Date().toISOString(),
      caso_atualizado_por: usuario?.email || "",
      caso_atualizado_em: new Date().toISOString(),
    };

    let query = supabase.from("casos").update(depois);

    if (registro) {
      query = query.eq("registro_unico", registro);
    } else {
      query = query.eq("id", id);
    }

    const { error } = await query;

    setSalvandoCaso(false);

    if (error) {
      alert("Erro ao salvar ajuste do caso: " + error.message);
      return;
    }

    await registrarHistorico({
      caso_registro_unico: registro || null,
      tipo_alteracao: "AJUSTE_VALOR_CASO",
      campo_alterado: "valor_cobranca_ajustado",
      valor_anterior: String(pegarValorCaso(casoAberto) || ""),
      valor_novo: String(depois.valor_cobranca_ajustado || ""),
      antes,
      depois,
      observacao: ajusteCaso.motivo_ajuste_valor || ajusteCaso.cadastro_caso_observacao || "Valor/caso ajustado no CRM.",
    });

    alert("Caso ajustado com histórico salvo.");

    setCasoAberto(null);

    if (onAtualizar) onAtualizar();
  }

  return (
    <div style={styles.card}>
      <h2 style={styles.titulo}>Ajustes de Cadastro e Valores</h2>
      <p style={styles.texto}>
        Use esta área para corrigir cadastro ou valor sem apagar o dado original. Toda alteração fica registrada em histórico.
      </p>

      <div style={styles.bloco}>
        <h3 style={styles.subtitulo}>Cadastro do aluno</h3>

        <div style={styles.grid}>
          <input style={styles.input} placeholder="Nome editado" value={cadastro.nome_aluno_editado} onChange={(e) => setCadastro({ ...cadastro, nome_aluno_editado: e.target.value })} />
          <input style={styles.input} placeholder="CPF editado" value={cadastro.cpf_referencia_editado} onChange={(e) => setCadastro({ ...cadastro, cpf_referencia_editado: e.target.value })} />
          <input style={styles.input} placeholder="Telefone" value={cadastro.telefone_aluno} onChange={(e) => setCadastro({ ...cadastro, telefone_aluno: e.target.value })} />
          <input style={styles.input} placeholder="E-mail" value={cadastro.email_aluno} onChange={(e) => setCadastro({ ...cadastro, email_aluno: e.target.value })} />
          <input style={styles.input} placeholder="Curso" value={cadastro.curso_aluno} onChange={(e) => setCadastro({ ...cadastro, curso_aluno: e.target.value })} />
          <input style={styles.input} placeholder="Unidade" value={cadastro.unidade_aluno} onChange={(e) => setCadastro({ ...cadastro, unidade_aluno: e.target.value })} />
        </div>

        <textarea style={styles.textarea} placeholder="Observação sobre ajuste cadastral" value={cadastro.observacao_cadastro} onChange={(e) => setCadastro({ ...cadastro, observacao_cadastro: e.target.value })} />

        <button style={styles.botaoAzul} onClick={salvarCadastro} disabled={salvandoCadastro}>
          {salvandoCadastro ? "Salvando..." : "Salvar ajuste cadastral"}
        </button>
      </div>

      <div style={styles.bloco}>
        <h3 style={styles.subtitulo}>Casos financeiros</h3>

        {casos.length === 0 && <p style={styles.texto}>Nenhum caso vinculado.</p>}

        {casos.map((caso, index) => (
          <div key={caso.registro_unico || caso.id || index} style={styles.caso}>
            <div>
              <strong>Caso {index + 1}</strong>
              <p style={styles.info}>Valor atual/base: {dinheiro(pegarValorCaso(caso))}</p>
              <p style={styles.info}>Valor ajustado: {caso.valor_cobranca_ajustado ? dinheiro(caso.valor_cobranca_ajustado) : "-"}</p>
              <p style={styles.info}>Status financeiro: {caso.status_financeiro || "EM_ABERTO"}</p>
              {caso.motivo_ajuste_valor && <p style={styles.info}>Motivo: {caso.motivo_ajuste_valor}</p>}
            </div>

            <button style={styles.botaoCinza} onClick={() => abrirAjusteCaso(caso)}>
              Ajustar valor/caso
            </button>
          </div>
        ))}
      </div>

      {casoAberto && (
        <div style={styles.modal}>
          <div style={styles.modalBox}>
            <h3 style={styles.subtitulo}>Ajustar caso selecionado</h3>

            <input
              style={styles.input}
              placeholder="Novo valor de cobrança. Ex.: 1200,50"
              value={ajusteCaso.valor_cobranca_ajustado}
              onChange={(e) => setAjusteCaso({ ...ajusteCaso, valor_cobranca_ajustado: e.target.value })}
            />

            <textarea
              style={styles.textarea}
              placeholder="Motivo do ajuste de valor"
              value={ajusteCaso.motivo_ajuste_valor}
              onChange={(e) => setAjusteCaso({ ...ajusteCaso, motivo_ajuste_valor: e.target.value })}
            />

            <textarea
              style={styles.textarea}
              placeholder="Observação do caso"
              value={ajusteCaso.cadastro_caso_observacao}
              onChange={(e) => setAjusteCaso({ ...ajusteCaso, cadastro_caso_observacao: e.target.value })}
            />

            <div style={styles.acoes}>
              <button style={styles.botaoAzul} onClick={salvarCaso} disabled={salvandoCaso}>
                {salvandoCaso ? "Salvando..." : "Salvar ajuste do caso"}
              </button>

              <button style={styles.botaoCinza} onClick={() => setCasoAberto(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  card: { background: "#fff", borderRadius: "14px", padding: "18px", marginBottom: "16px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", borderLeft: "6px solid #6f42c1" },
  titulo: { margin: 0, color: "#111827" },
  texto: { margin: "6px 0 14px 0", color: "#555" },
  bloco: { background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: "12px", padding: "14px", marginTop: "14px" },
  subtitulo: { margin: "0 0 12px 0", color: "#111827" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "10px" },
  input: { padding: "11px", borderRadius: "8px", border: "1px solid #d1d5db", fontSize: "14px", width: "100%", boxSizing: "border-box" },
  textarea: { width: "100%", minHeight: "70px", marginTop: "10px", padding: "11px", borderRadius: "8px", border: "1px solid #d1d5db", boxSizing: "border-box", fontFamily: "Arial, sans-serif" },
  caso: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "12px", marginBottom: "10px", display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" },
  info: { margin: "4px 0", color: "#555" },
  botaoAzul: { background: "#0d6efd", color: "#fff", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold", marginTop: "10px" },
  botaoCinza: { background: "#e5e7eb", color: "#111827", border: "none", padding: "11px 14px", borderRadius: "8px", cursor: "pointer", fontWeight: "bold" },
  modal: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 },
  modalBox: { background: "#fff", borderRadius: "14px", padding: "20px", width: "min(620px, 92vw)", boxShadow: "0 10px 30px rgba(0,0,0,0.25)" },
  acoes: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "10px" },
};
