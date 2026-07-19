import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const EMAIL_AMANDA = "amanda.seibel@aelbra.com.br";

const PAPEIS = ["OPERADOR", "GERENTE", "SUPERVISORA", "OUTRO"];

const STATUS_FECHAMENTO = [
  "RASCUNHO",
  "ENVIADO_FINANCEIRO",
  "NOTA_ANEXADA",
  "PAGO",
];
const STATUS_LABEL = {
  RASCUNHO: "Rascunho (só você vê)",
  ENVIADO_FINANCEIRO: "Enviado ao financeiro",
  NOTA_ANEXADA: "Nota anexada pelo operador",
  PAGO: "Pago",
};

function moeda(valor) {
  if (valor === null || valor === undefined || valor === "") return "-";
  const n = Number(valor);
  if (Number.isNaN(n)) return "-";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function numeroOuNull(valor) {
  if (valor === "" || valor === null || valor === undefined) return null;
  const n = Number(valor);
  return Number.isNaN(n) ? null : n;
}

function mesAtualISO() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

export default function GestaoFinanceiraOperadores() {
  const [usuario, setUsuario] = useState(null);
  const [aba, setAba] = useState("FECHAMENTO");

  const [operadores, setOperadores] = useState([]);
  const [formOperador, setFormOperador] = useState(null);
  const [editandoOperadorId, setEditandoOperadorId] = useState(null);
  const [enviandoContrato, setEnviandoContrato] = useState(false);

  const [mesReferencia, setMesReferencia] = useState(mesAtualISO());
  const [parametros, setParametros] = useState([]);
  const [formParametro, setFormParametro] = useState({
    tier: "META_1",
    valor_minimo: "",
    valor_maximo: "",
    percentual: "",
    aplica_sobre: "HONORARIOS_INDIVIDUAL",
  });

  const [fechamentos, setFechamentos] = useState([]);
  const [carregandoFechamentos, setCarregandoFechamentos] = useState(false);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");

  useEffect(() => {
    carregarUsuario();
  }, []);

  useEffect(() => {
    if (!podeUsar) return;
    carregarOperadores();
    carregarParametros();
    carregarFechamentos();
  }, [usuario, mesReferencia]);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  const podeUsar = usuario?.email?.toLowerCase() === EMAIL_AMANDA;

  async function carregarOperadores() {
    const { data, error } = await supabase
      .from("rh_dados_operadores")
      .select("*")
      .order("operador_nome", { ascending: true });

    if (error) {
      console.error("Erro ao carregar operadores:", error);
      return;
    }
    setOperadores(data || []);
  }

  async function carregarParametros() {
    const { data, error } = await supabase
      .from("rh_parametros_comissao")
      .select("*")
      .eq("mes_referencia", mesReferencia)
      .order("valor_minimo", { ascending: true });

    if (error) {
      console.error("Erro ao carregar parâmetros:", error);
      return;
    }
    setParametros(data || []);
  }

  async function carregarFechamentos() {
    setCarregandoFechamentos(true);
    const { data, error } = await supabase
      .from("rh_fechamentos_mensais")
      .select("*")
      .eq("mes_referencia", mesReferencia)
      .order("operador_nome", { ascending: true });

    setCarregandoFechamentos(false);

    if (error) {
      console.error("Erro ao carregar fechamentos:", error);
      return;
    }
    setFechamentos(data || []);
  }

  // ---- Cadastro de operadores ----

  function novoFormOperador() {
    setEditandoOperadorId(null);
    setFormOperador({
      operador_email: "",
      operador_nome: "",
      nome_completo: "",
      cnpj: "",
      banco: "",
      agencia: "",
      conta: "",
      tipo_conta: "",
      chave_pix: "",
      valor_salario_base: "",
      ativo: true,
    });
  }

  function editarOperador(op) {
    setEditandoOperadorId(op.id);
    setFormOperador({ ...op });
  }

  async function salvarOperador() {
    if (!formOperador.operador_email || !formOperador.nome_completo) {
      alert("Preencha pelo menos e-mail e nome completo.");
      return;
    }

    const payload = {
      ...formOperador,
      valor_salario_base: numeroOuNull(formOperador.valor_salario_base),
      atualizado_em: new Date().toISOString(),
    };

    const { error } = await supabase.from("rh_dados_operadores").upsert(payload, {
      onConflict: "operador_email",
    });

    if (error) {
      alert("Erro ao salvar operador: " + error.message);
      return;
    }

    setFormOperador(null);
    setEditandoOperadorId(null);
    carregarOperadores();
  }

  async function enviarContrato(arquivo) {
    if (!arquivo || !formOperador?.operador_email) {
      alert("Preencha o e-mail do operador e salve antes de anexar o contrato.");
      return;
    }

    setEnviandoContrato(true);

    try {
      const nomeSeguro = arquivo.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const caminho = `${formOperador.operador_email}/contrato-${Date.now()}-${nomeSeguro}`;

      const { error: erroUpload } = await supabase.storage
        .from("documentos-operadores")
        .upload(caminho, arquivo);

      if (erroUpload) throw erroUpload;

      const { data: assinada } = await supabase.storage
        .from("documentos-operadores")
        .createSignedUrl(caminho, 60 * 60 * 24 * 365 * 5);

      setFormOperador((atual) => ({
        ...atual,
        contrato_url: assinada?.signedUrl || caminho,
        contrato_nome: arquivo.name,
        contrato_atualizado_em: new Date().toISOString(),
      }));
    } catch (e) {
      alert("Erro ao anexar contrato: " + (e.message || "tente novamente."));
    } finally {
      setEnviandoContrato(false);
    }
  }

  // ---- Parâmetros de comissão do mês ----

  async function salvarParametro() {
    if (!formParametro.tier || formParametro.percentual === "") {
      alert("Preencha a faixa e o percentual.");
      return;
    }

    const payload = {
      mes_referencia: mesReferencia,
      tier: formParametro.tier,
      valor_minimo: numeroOuNull(formParametro.valor_minimo) || 0,
      valor_maximo: numeroOuNull(formParametro.valor_maximo),
      percentual: numeroOuNull(formParametro.percentual),
      aplica_sobre: formParametro.aplica_sobre,
    };

    const { error } = await supabase
      .from("rh_parametros_comissao")
      .upsert(payload, { onConflict: "mes_referencia,tier" });

    if (error) {
      alert("Erro ao salvar parâmetro: " + error.message);
      return;
    }

    setFormParametro({
      tier: "META_1",
      valor_minimo: "",
      valor_maximo: "",
      percentual: "",
      aplica_sobre: "HONORARIOS_INDIVIDUAL",
    });
    carregarParametros();
  }

  async function removerParametro(id) {
    if (!confirm("Remover essa faixa?")) return;
    await supabase.from("rh_parametros_comissao").delete().eq("id", id);
    carregarParametros();
  }

  // ---- Fechamento mensal ----

  async function gerarFechamentosDoMes() {
    const ativos = operadores.filter((o) => o.ativo);

    if (ativos.length === 0) {
      alert("Cadastre os operadores na aba Cadastro antes de gerar o fechamento.");
      return;
    }

    const existentes = new Set(fechamentos.map((f) => f.operador_email));
    const novos = ativos
      .filter((o) => !existentes.has(o.operador_email))
      .map((o) => ({
        mes_referencia: mesReferencia,
        operador_email: o.operador_email,
        operador_nome: o.nome_completo || o.operador_nome,
        papel: "OPERADOR",
        valor_salario: o.valor_salario_base,
        status: "RASCUNHO",
        criado_por_email: usuario.email,
      }));

    if (novos.length === 0) {
      setAviso("Todos os operadores ativos já têm fechamento neste mês.");
      setTimeout(() => setAviso(""), 4000);
      return;
    }

    const { error } = await supabase.from("rh_fechamentos_mensais").insert(novos);

    if (error) {
      alert("Erro ao gerar fechamentos: " + error.message);
      return;
    }

    carregarFechamentos();
  }

  function atualizarCampoFechamento(id, campo, valor) {
    setFechamentos((atual) =>
      atual.map((f) => (f.id === id ? { ...f, [campo]: valor } : f))
    );
  }

  function calcularAutomatico(fechamento) {
    const honorarios = Number(fechamento.valor_honorarios) || 0;

    if (fechamento.papel === "GERENTE" || fechamento.papel === "SUPERVISORA") {
      const paramEspecial = parametros.find(
        (p) => p.tier === fechamento.papel && p.aplica_sobre === "HONORARIOS_TOTAL_EMPRESA"
      );

      if (!paramEspecial) {
        alert(
          `Cadastre na aba "Parâmetros do mês" a faixa "${fechamento.papel}" (aplica sobre honorários total da empresa) antes de calcular.`
        );
        return;
      }

      const comissao = honorarios * Number(paramEspecial.percentual);
      atualizarFechamentoCalculado(fechamento.id, {
        tier_aplicado: fechamento.papel,
        percentual_comissao: paramEspecial.percentual,
        valor_comissao: Math.round(comissao * 100) / 100,
      });
      return;
    }

    const tiersIndividuais = parametros
      .filter((p) => p.aplica_sobre === "HONORARIOS_INDIVIDUAL")
      .sort((a, b) => Number(a.valor_minimo) - Number(b.valor_minimo));

    const faixa = tiersIndividuais.find((p) => {
      const min = Number(p.valor_minimo) || 0;
      const max = p.valor_maximo === null || p.valor_maximo === undefined ? Infinity : Number(p.valor_maximo);
      return honorarios >= min && honorarios <= max;
    });

    if (!faixa) {
      alert(
        `Nenhuma faixa de meta cadastrada pra esse valor de honorários. Cadastre as faixas na aba "Parâmetros do mês".`
      );
      return;
    }

    const comissao = honorarios * Number(faixa.percentual);
    atualizarFechamentoCalculado(fechamento.id, {
      tier_aplicado: faixa.tier,
      percentual_comissao: faixa.percentual,
      valor_comissao: Math.round(comissao * 100) / 100,
    });
  }

  function atualizarFechamentoCalculado(id, campos) {
    setFechamentos((atual) =>
      atual.map((f) => (f.id === id ? { ...f, ...campos } : f))
    );
  }

  async function salvarFechamento(f) {
    const comissao = numeroOuNull(f.valor_comissao) || 0;
    const salario = numeroOuNull(f.valor_salario) || 0;

    const payload = {
      papel: f.papel,
      valor_recuperado: numeroOuNull(f.valor_recuperado),
      valor_honorarios: numeroOuNull(f.valor_honorarios),
      tier_aplicado: f.tier_aplicado || null,
      percentual_comissao: numeroOuNull(f.percentual_comissao),
      valor_comissao: comissao,
      valor_salario: salario,
      valor_total: Math.round((comissao + salario) * 100) / 100,
      status: f.status,
      observacao: f.observacao || null,
      atualizado_em: new Date().toISOString(),
      enviado_financeiro_em:
        f.status === "ENVIADO_FINANCEIRO" ? new Date().toISOString() : f.enviado_financeiro_em,
    };

    const { error } = await supabase
      .from("rh_fechamentos_mensais")
      .update(payload)
      .eq("id", f.id);

    if (error) {
      alert("Erro ao salvar fechamento: " + error.message);
      return;
    }

    carregarFechamentos();
  }

  async function removerFechamento(id) {
    if (!confirm("Remover esse fechamento?")) return;
    await supabase.from("rh_fechamentos_mensais").delete().eq("id", id);
    carregarFechamentos();
  }

  const totais = useMemo(() => {
    return fechamentos.reduce(
      (acc, f) => ({
        comissao: acc.comissao + (Number(f.valor_comissao) || 0),
        salario: acc.salario + (Number(f.valor_salario) || 0),
        total: acc.total + (Number(f.valor_total) || 0),
      }),
      { comissao: 0, salario: 0, total: 0 }
    );
  }, [fechamentos]);

  if (!usuario) return <div style={estilos.container}>Carregando...</div>;

  if (!podeUsar) {
    return (
      <div style={estilos.container}>
        <div style={estilos.alertaRestrito}>
          Acesso restrito. Esta área só pode ser vista pela gestora.
        </div>
      </div>
    );
  }

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalhoRestrito}>
        🔒 Área confidencial — visível somente para você. Contém salário, CNPJ e dados
        bancários dos operadores.
      </div>

      <h1 style={estilos.titulo}>Financeiro dos Operadores</h1>

      <div style={estilos.abas}>
        {[
          ["CADASTRO", "Cadastro dos operadores"],
          ["PARAMETROS", "Parâmetros do mês"],
          ["FECHAMENTO", "Fechamento mensal"],
        ].map(([valor, label]) => (
          <button
            key={valor}
            onClick={() => setAba(valor)}
            style={{
              ...estilos.botaoAba,
              ...(aba === valor ? estilos.botaoAbaAtiva : {}),
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {aba === "CADASTRO" && (
        <div style={estilos.card}>
          <div style={estilos.linhaTopo}>
            <h2 style={estilos.subtitulo}>Operadores cadastrados</h2>
            <button style={estilos.botaoAzul} onClick={novoFormOperador}>
              + Novo operador
            </button>
          </div>

          {formOperador && (
            <div style={estilos.formBox}>
              <div style={estilos.grid2}>
                <input
                  style={estilos.input}
                  placeholder="E-mail (login no CRM)"
                  value={formOperador.operador_email}
                  disabled={Boolean(editandoOperadorId)}
                  onChange={(e) =>
                    setFormOperador({ ...formOperador, operador_email: e.target.value })
                  }
                />
                <input
                  style={estilos.input}
                  placeholder="Nome como aparece no CRM"
                  value={formOperador.operador_nome || ""}
                  onChange={(e) =>
                    setFormOperador({ ...formOperador, operador_nome: e.target.value })
                  }
                />
                <input
                  style={estilos.input}
                  placeholder="Nome completo"
                  value={formOperador.nome_completo || ""}
                  onChange={(e) =>
                    setFormOperador({ ...formOperador, nome_completo: e.target.value })
                  }
                />
                <input
                  style={estilos.input}
                  placeholder="CNPJ"
                  value={formOperador.cnpj || ""}
                  onChange={(e) => setFormOperador({ ...formOperador, cnpj: e.target.value })}
                />
                <input
                  style={estilos.input}
                  placeholder="Banco"
                  value={formOperador.banco || ""}
                  onChange={(e) => setFormOperador({ ...formOperador, banco: e.target.value })}
                />
                <input
                  style={estilos.input}
                  placeholder="Agência"
                  value={formOperador.agencia || ""}
                  onChange={(e) => setFormOperador({ ...formOperador, agencia: e.target.value })}
                />
                <input
                  style={estilos.input}
                  placeholder="Conta"
                  value={formOperador.conta || ""}
                  onChange={(e) => setFormOperador({ ...formOperador, conta: e.target.value })}
                />
                <input
                  style={estilos.input}
                  placeholder="Tipo de conta (corrente/poupança)"
                  value={formOperador.tipo_conta || ""}
                  onChange={(e) =>
                    setFormOperador({ ...formOperador, tipo_conta: e.target.value })
                  }
                />
                <input
                  style={estilos.input}
                  placeholder="Chave PIX"
                  value={formOperador.chave_pix || ""}
                  onChange={(e) =>
                    setFormOperador({ ...formOperador, chave_pix: e.target.value })
                  }
                />
                <input
                  style={estilos.input}
                  type="number"
                  step="0.01"
                  placeholder="Salário base"
                  value={formOperador.valor_salario_base ?? ""}
                  onChange={(e) =>
                    setFormOperador({ ...formOperador, valor_salario_base: e.target.value })
                  }
                />
              </div>

              <label style={estilos.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={formOperador.ativo}
                  onChange={(e) =>
                    setFormOperador({ ...formOperador, ativo: e.target.checked })
                  }
                />
                Ativo (entra no fechamento em lote)
              </label>

              <div style={{ marginTop: 10 }}>
                <label style={estilos.labelPequeno}>Contrato do operador</label>
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                  disabled={enviandoContrato}
                  onChange={(e) => enviarContrato(e.target.files?.[0])}
                />
                {enviandoContrato && <span style={{ fontSize: 12 }}> Enviando...</span>}
                {formOperador.contrato_nome && (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    📄 {formOperador.contrato_nome}
                    {formOperador.contrato_url && (
                      <>
                        {" — "}
                        <a href={formOperador.contrato_url} target="_blank" rel="noreferrer">
                          ver contrato
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button style={estilos.botaoVerde} onClick={salvarOperador}>
                  Salvar
                </button>
                <button style={estilos.botaoCinza} onClick={() => setFormOperador(null)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}

          <table style={estilos.tabela}>
            <thead>
              <tr>
                <th style={estilos.th}>Nome</th>
                <th style={estilos.th}>CNPJ</th>
                <th style={estilos.th}>Banco/Conta</th>
                <th style={estilos.th}>PIX</th>
                <th style={estilos.th}>Salário base</th>
                <th style={estilos.th}>Contrato</th>
                <th style={estilos.th}>Status</th>
                <th style={estilos.th}></th>
              </tr>
            </thead>
            <tbody>
              {operadores.map((op) => (
                <tr key={op.id}>
                  <td style={estilos.td}>
                    <div style={{ fontWeight: 700 }}>{op.nome_completo}</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{op.operador_email}</div>
                  </td>
                  <td style={estilos.td}>{op.cnpj || "-"}</td>
                  <td style={estilos.td}>
                    {op.banco ? `${op.banco} · Ag ${op.agencia || "-"} · Cc ${op.conta || "-"}` : "-"}
                  </td>
                  <td style={estilos.td}>{op.chave_pix || "-"}</td>
                  <td style={estilos.td}>{moeda(op.valor_salario_base)}</td>
                  <td style={estilos.td}>
                    {op.contrato_url ? (
                      <a href={op.contrato_url} target="_blank" rel="noreferrer">
                        Ver contrato
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td style={estilos.td}>{op.ativo ? "Ativo" : "Inativo"}</td>
                  <td style={estilos.td}>
                    <button style={estilos.botaoCinza} onClick={() => editarOperador(op)}>
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
              {operadores.length === 0 && (
                <tr>
                  <td style={estilos.td} colSpan={8}>
                    Nenhum operador cadastrado ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {aba !== "CADASTRO" && (
        <div style={estilos.seletorMes}>
          <label style={{ fontSize: 13, fontWeight: 700 }}>Mês de referência</label>
          <input
            type="month"
            value={mesReferencia}
            onChange={(e) => setMesReferencia(e.target.value)}
            style={estilos.input}
          />
        </div>
      )}

      {aba === "PARAMETROS" && (
        <div style={estilos.card}>
          <h2 style={estilos.subtitulo}>Faixas de meta/comissão — {mesReferencia}</h2>
          <p style={estilos.textoAuxiliar}>
            As faixas mudam de mês pra mês, então cadastre de novo (ou ajuste) sempre que o
            valor mudar. "Aplica sobre" define se o percentual incide no honorário
            individual do operador (faixas de meta normais) ou no honorário total da
            empresa no mês (caso de Gerente/Supervisora).
          </p>

          <div style={estilos.formBox}>
            <div style={estilos.grid2}>
              <input
                style={estilos.input}
                placeholder="Nome da faixa (ex: META_1, GERENTE, PERSONALIZADO)"
                value={formParametro.tier}
                onChange={(e) => setFormParametro({ ...formParametro, tier: e.target.value })}
              />
              <select
                style={estilos.input}
                value={formParametro.aplica_sobre}
                onChange={(e) =>
                  setFormParametro({ ...formParametro, aplica_sobre: e.target.value })
                }
              >
                <option value="HONORARIOS_INDIVIDUAL">Honorário individual do operador</option>
                <option value="HONORARIOS_TOTAL_EMPRESA">Honorário total da empresa no mês</option>
              </select>
              <input
                style={estilos.input}
                type="number"
                step="0.01"
                placeholder="Valor mínimo da faixa"
                value={formParametro.valor_minimo}
                onChange={(e) =>
                  setFormParametro({ ...formParametro, valor_minimo: e.target.value })
                }
              />
              <input
                style={estilos.input}
                type="number"
                step="0.01"
                placeholder="Valor máximo (vazio = sem limite)"
                value={formParametro.valor_maximo}
                onChange={(e) =>
                  setFormParametro({ ...formParametro, valor_maximo: e.target.value })
                }
              />
              <input
                style={estilos.input}
                type="number"
                step="0.0001"
                placeholder="Percentual (ex: 0.095 = 9,5%)"
                value={formParametro.percentual}
                onChange={(e) =>
                  setFormParametro({ ...formParametro, percentual: e.target.value })
                }
              />
            </div>
            <button style={estilos.botaoVerde} onClick={salvarParametro}>
              Salvar faixa
            </button>
          </div>

          <table style={estilos.tabela}>
            <thead>
              <tr>
                <th style={estilos.th}>Faixa</th>
                <th style={estilos.th}>Aplica sobre</th>
                <th style={estilos.th}>De</th>
                <th style={estilos.th}>Até</th>
                <th style={estilos.th}>%</th>
                <th style={estilos.th}></th>
              </tr>
            </thead>
            <tbody>
              {parametros.map((p) => (
                <tr key={p.id}>
                  <td style={estilos.td}>{p.tier}</td>
                  <td style={estilos.td}>
                    {p.aplica_sobre === "HONORARIOS_TOTAL_EMPRESA"
                      ? "Total da empresa"
                      : "Individual"}
                  </td>
                  <td style={estilos.td}>{moeda(p.valor_minimo)}</td>
                  <td style={estilos.td}>{p.valor_maximo === null ? "Sem limite" : moeda(p.valor_maximo)}</td>
                  <td style={estilos.td}>{(Number(p.percentual) * 100).toFixed(2)}%</td>
                  <td style={estilos.td}>
                    <button style={estilos.botaoCinza} onClick={() => removerParametro(p.id)}>
                      Remover
                    </button>
                  </td>
                </tr>
              ))}
              {parametros.length === 0 && (
                <tr>
                  <td style={estilos.td} colSpan={6}>
                    Nenhuma faixa cadastrada para este mês ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {aba === "FECHAMENTO" && (
        <div style={estilos.card}>
          <div style={estilos.linhaTopo}>
            <h2 style={estilos.subtitulo}>Fechamento — {mesReferencia}</h2>
            <button style={estilos.botaoAzul} onClick={gerarFechamentosDoMes}>
              Gerar fechamento pros operadores ativos
            </button>
          </div>

          {aviso && <p style={estilos.aviso}>{aviso}</p>}

          <div style={estilos.resumoTotais}>
            <span>Comissões: {moeda(totais.comissao)}</span>
            <span>Salários: {moeda(totais.salario)}</span>
            <span style={{ fontWeight: 800 }}>Total geral: {moeda(totais.total)}</span>
          </div>

          {carregandoFechamentos ? (
            <p style={estilos.textoAuxiliar}>Carregando...</p>
          ) : fechamentos.length === 0 ? (
            <p style={estilos.textoAuxiliar}>
              Nenhum fechamento gerado ainda pra este mês. Clique em "Gerar fechamento" acima.
            </p>
          ) : (
            fechamentos.map((f) => (
              <div key={f.id} style={estilos.linhaFechamento}>
                <div style={estilos.grid3}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{f.operador_nome}</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{f.operador_email}</div>

                    <select
                      style={estilos.inputPequeno}
                      value={f.papel}
                      onChange={(e) => atualizarCampoFechamento(f.id, "papel", e.target.value)}
                    >
                      {PAPEIS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={estilos.labelPequeno}>Recuperado</label>
                    <input
                      type="number"
                      step="0.01"
                      style={estilos.inputPequeno}
                      value={f.valor_recuperado ?? ""}
                      onChange={(e) =>
                        atualizarCampoFechamento(f.id, "valor_recuperado", e.target.value)
                      }
                    />

                    <label style={estilos.labelPequeno}>
                      Honorários {f.papel !== "OPERADOR" ? "(total empresa no mês)" : ""}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      style={estilos.inputPequeno}
                      value={f.valor_honorarios ?? ""}
                      onChange={(e) =>
                        atualizarCampoFechamento(f.id, "valor_honorarios", e.target.value)
                      }
                    />
                  </div>

                  <div>
                    <button
                      style={estilos.botaoCinza}
                      onClick={() => calcularAutomatico(f)}
                      type="button"
                    >
                      Calcular automático
                    </button>

                    <label style={estilos.labelPequeno}>Faixa aplicada</label>
                    <input
                      style={estilos.inputPequeno}
                      value={f.tier_aplicado || ""}
                      onChange={(e) =>
                        atualizarCampoFechamento(f.id, "tier_aplicado", e.target.value)
                      }
                    />

                    <label style={estilos.labelPequeno}>% comissão</label>
                    <input
                      type="number"
                      step="0.0001"
                      style={estilos.inputPequeno}
                      value={f.percentual_comissao ?? ""}
                      onChange={(e) =>
                        atualizarCampoFechamento(f.id, "percentual_comissao", e.target.value)
                      }
                    />
                  </div>

                  <div>
                    <label style={estilos.labelPequeno}>Valor comissão</label>
                    <input
                      type="number"
                      step="0.01"
                      style={estilos.inputPequeno}
                      value={f.valor_comissao ?? ""}
                      onChange={(e) =>
                        atualizarCampoFechamento(f.id, "valor_comissao", e.target.value)
                      }
                    />

                    <label style={estilos.labelPequeno}>Salário</label>
                    <input
                      type="number"
                      step="0.01"
                      style={estilos.inputPequeno}
                      value={f.valor_salario ?? ""}
                      onChange={(e) =>
                        atualizarCampoFechamento(f.id, "valor_salario", e.target.value)
                      }
                    />

                    <div style={{ fontWeight: 800, marginTop: 6 }}>
                      Total: {moeda((Number(f.valor_comissao) || 0) + (Number(f.valor_salario) || 0))}
                    </div>
                  </div>

                  <div>
                    <label style={estilos.labelPequeno}>Status</label>
                    <select
                      style={estilos.inputPequeno}
                      value={f.status}
                      onChange={(e) => atualizarCampoFechamento(f.id, "status", e.target.value)}
                    >
                      {STATUS_FECHAMENTO.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>

                    {f.nota_fiscal_url && (
                      <a
                        href={f.nota_fiscal_url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: "block", fontSize: 12, marginTop: 6, color: "#0d6efd" }}
                      >
                        Ver nota fiscal anexada
                      </a>
                    )}

                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button style={estilos.botaoVerde} onClick={() => salvarFechamento(f)}>
                        Salvar
                      </button>
                      <button style={estilos.botaoCinza} onClick={() => removerFechamento(f.id)}>
                        Remover
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

const estilos = {
  container: { minHeight: "100%", padding: "28px 30px 40px", color: "#334155", fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa" },
  cabecalhoRestrito: {
    background: "#fef2f2",
    color: "#dc2626",
    padding: "10px 14px",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 13,
    marginBottom: 16,
    border: "1px solid #fecaca",
  },
  alertaRestrito: {
    background: "#fef2f2",
    color: "#dc2626",
    padding: "20px",
    borderRadius: 14,
    fontWeight: 700,
    border: "1px solid #fecaca",
  },
  titulo: { margin: "0 0 16px 0", color: "#0d1321", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: 0, fontSize: 14, color: "#8a93a3" },
  abas: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  botaoAba: {
    padding: "8px 14px",
    borderRadius: 10,
    border: "1px solid #e2e8f0",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13,
    color: "#334155",
  },
  botaoAbaAtiva: { background: "#2563eb", color: "#fff", borderColor: "#2563eb" },
  card: { background: "#fff", borderRadius: 16, padding: 20, marginBottom: 16, border: "1px solid #edf0f5", boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  linhaTopo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
    flexWrap: "wrap",
    gap: 10,
  },
  formBox: {
    background: "#f8fafc",
    padding: 14,
    borderRadius: 12,
    marginBottom: 16,
    border: "1px solid #e2e8f0",
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 10,
    marginBottom: 10,
  },
  grid3: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 14,
  },
  input: {
    padding: "9px 10px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    fontSize: 13,
    color: "#0d1321",
    background: "#ffffff",
  },
  inputPequeno: {
    width: "100%",
    padding: "6px 8px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    fontSize: 12,
    marginBottom: 6,
    boxSizing: "border-box",
    color: "#0d1321",
    background: "#ffffff",
  },
  labelPequeno: { fontSize: 10, color: "#8a93a3", display: "block", marginTop: 4 },
  checkboxLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155" },
  botaoAzul: {
    background: "#2563eb",
    color: "#fff",
    border: "none",
    padding: "9px 14px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13,
  },
  botaoVerde: {
    background: "#16a34a",
    color: "#fff",
    border: "none",
    padding: "8px 12px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  },
  botaoCinza: {
    background: "#f1f5f9",
    color: "#334155",
    border: "none",
    padding: "8px 12px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  },
  tabela: { width: "100%", borderCollapse: "collapse", marginTop: 6 },
  th: {
    textAlign: "left",
    padding: "10px 8px",
    borderBottom: "1px solid #e3e7ee",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#8a93a3",
    background: "#f8fafc",
  },
  td: { padding: "9px 8px", borderBottom: "1px solid #f2f4f7", fontSize: 13, color: "#0d1321" },
  textoAuxiliar: { fontSize: 13, color: "#8a93a3" },
  seletorMes: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  linhaFechamento: {
    borderBottom: "1px solid #f2f4f7",
    padding: "14px 0",
  },
  resumoTotais: {
    display: "flex",
    gap: 20,
    fontSize: 13,
    marginBottom: 14,
    flexWrap: "wrap",
    color: "#334155",
  },
  aviso: { fontSize: 13, color: "#b45309" },
};
