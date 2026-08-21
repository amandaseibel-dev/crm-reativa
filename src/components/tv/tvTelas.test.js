import { describe, it, expect } from "vitest";
import { telasVisiveis, telasParaAdmin, CATALOGO_TELAS } from "./tvTelas";

// Snapshot mínimo que dá conteúdo a um subconjunto de slides. Slides sem a chave
// correspondente ficam SEM conteúdo (trava dura do carrossel).
function snapBase(extra = {}) {
  return {
    hoje: {},
    mes: { meta_empresa: 450000 },
    rankings: { melhor_mes: { operador: "X" } },
    dados: { ranking_semana: [{ operador: "A" }] },
    rank: { top_dia: [{ nome: "A", qtd: 3 }] },
    aniversariantes: [{ nome: "Z", dia: 10 }],
    elogios: [{ id: 1 }],
    avisos: [{ titulo: "oi", mensagem: "x" }],
    julho_historico: { ativo: false },
    metas: [],
    premiacao: { faixas: [] },
    aniversario_destaque: null,
    ...extra,
  };
}

const ids = (arr) => arr.map((t) => t.id);

describe("telasVisiveis — padrão do catálogo", () => {
  it("mostra os slides ligados de fábrica que têm conteúdo e esconde os sem conteúdo", () => {
    const vis = ids(telasVisiveis(snapBase()));
    expect(vis).toContain("hoje");
    expect(vis).toContain("magic_number");
    expect(vis).toContain("avisos");
    // metas/premiacao são ativa:false; julho está inativo no snapshot
    expect(vis).not.toContain("metas");
    expect(vis).not.toContain("premiacao");
    expect(vis).not.toContain("julho");
    // placeholders nunca entram por padrão
    expect(vis).not.toContain("hall");
  });
});

describe("telasVisiveis — override de visibilidade", () => {
  it("oculta um slide ligado de fábrica quando telas_config diz visivel:false", () => {
    const vis = ids(telasVisiveis(snapBase({ telas_config: { hoje: { visivel: false } } })));
    expect(vis).not.toContain("hoje");
    expect(vis).toContain("magic_number"); // os demais seguem normais
  });

  it("liga um slide desligado de fábrica quando há conteúdo", () => {
    const snap = snapBase({ metas: [{ id: "empresa" }], telas_config: { metas: { visivel: true } } });
    expect(ids(telasVisiveis(snap))).toContain("metas");
  });

  it("NÃO mostra um slide ligado se ele não tem conteúdo agora (trava dura)", () => {
    // metas ligado, mas snap.metas vazio => continua fora
    const snap = snapBase({ metas: [], telas_config: { metas: { visivel: true } } });
    expect(ids(telasVisiveis(snap))).not.toContain("metas");
  });
});

describe("telasVisiveis — ordem", () => {
  it("respeita telas_config.ordem (asc)", () => {
    const snap = snapBase({ telas_config: { magic_number: { ordem: 1 }, hoje: { ordem: 99 } } });
    const vis = ids(telasVisiveis(snap));
    expect(vis.indexOf("magic_number")).toBeLessThan(vis.indexOf("hoje"));
  });
});

describe("telasVisiveis — textos extras", () => {
  it("propaga subtitulo/observacao para o objeto da tela", () => {
    const snap = snapBase({ telas_config: { magic_number: { subtitulo: "Sub", observacao: "Obs" } } });
    const magic = telasVisiveis(snap).find((t) => t.id === "magic_number");
    expect(magic.extras).toEqual({ subtitulo: "Sub", observacao: "Obs" });
  });
});

describe("telasParaAdmin", () => {
  it("devolve TODOS os slides do catálogo (inclui ocultos e em construção)", () => {
    const admin = telasParaAdmin(snapBase(), {});
    expect(admin.length).toBe(CATALOGO_TELAS.length);
    expect(ids(admin)).toContain("hall"); // placeholder aparece no painel
  });

  it("reflete o override de visibilidade e o estado de conteúdo", () => {
    const admin = telasParaAdmin(snapBase(), { hoje: { visivel: false } });
    const hoje = admin.find((t) => t.id === "hoje");
    expect(hoje.visivel).toBe(false);
    expect(hoje.temConteudoAgora).toBe(true); // tem conteúdo, só está desligado

    const julho = admin.find((t) => t.id === "julho");
    expect(julho.temConteudoAgora).toBe(false);
  });

  it("marca placeholders com placeholder:true e grupo 'construcao'", () => {
    const admin = telasParaAdmin(snapBase(), {});
    const hall = admin.find((t) => t.id === "hall");
    expect(hall.placeholder).toBe(true);
    expect(hall.grupo).toBe("construcao");
  });

  it("temConteudoAgora é null quando não há snapshot", () => {
    const admin = telasParaAdmin(null, {});
    expect(admin.every((t) => t.temConteudoAgora === null)).toBe(true);
  });
});

describe("slides de imagem (imagens prontas do painel)", () => {
  const imagens = { itens: [
    { id: "a1", path: "a1.png", url: "https://x/a1.png", nome: "cartaz.png", legenda: "Campanha" },
    { id: "b2", path: "b2.jpg", url: "https://x/b2.jpg", nome: "foto.jpg", legenda: "" },
    { id: "semurl", path: "c.png", url: "", nome: "quebrada.png" },
  ] };

  it("cada imagem com url vira um slide 'img:<id>', ligado por padrão e no fim do rodízio", () => {
    const t = telasVisiveis(snapBase({ imagens }));
    const i = ids(t);
    expect(i.slice(-2)).toEqual(["img:a1", "img:b2"]);
    expect(i).not.toContain("img:semurl");
    expect(t.find((x) => x.id === "img:a1").nome).toBe("Campanha");
    expect(t.find((x) => x.id === "img:b2").nome).toBe("foto.jpg");
  });

  it("telas_config oculta e reordena imagem como qualquer slide", () => {
    const t = telasVisiveis(snapBase({ imagens, telas_config: { "img:b2": { visivel: false }, "img:a1": { ordem: 0 } } }));
    const i = ids(t);
    expect(i[0]).toBe("img:a1");
    expect(i).not.toContain("img:b2");
  });

  it("sem imagens no snapshot, o rodízio é o mesmo de antes", () => {
    expect(ids(telasVisiveis(snapBase()))).toEqual(ids(telasVisiveis(snapBase({ imagens: { itens: [] } }))));
  });

  it("telasParaAdmin lista as imagens passadas (mesmo fora do snapshot), com grupo 'imagem' e o item", () => {
    const t = telasParaAdmin(snapBase(), {}, imagens.itens);
    const img = t.find((x) => x.id === "img:a1");
    expect(img).toBeTruthy();
    expect(img.grupo).toBe("imagem");
    expect(img.imagem.url).toBe("https://x/a1.png");
    expect(img.visivel).toBe(true);
    expect(img.temConteudoAgora).toBe(true);
  });
});
